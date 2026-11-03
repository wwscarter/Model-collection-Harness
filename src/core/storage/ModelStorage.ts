import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { decryptAPIKey, encryptAPIKey } from "../../utils/crypto";
import { ModelConfig, cloneModelConfig } from "../models/ModelConfig";

export interface ModelStore {
  saveModel(config: ModelConfig): void;
  loadModel(id: string): ModelConfig | undefined;
  getAllModels(): ModelConfig[];
  deleteModel(id: string): void;
  close?(): void;
}

interface ModelRow {
  id: string;
  provider: ModelConfig["provider"];
  name: string;
  model_id: string;
  base_url: string | null;
  context_window: number;
  intelligence_score: number;
  capabilities: string;
  cost_per_1k_tokens: string;
  max_tokens: number;
  rate_limit: string;
  enabled: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  model_id: string;
  api_key: string;
  base_url: string | null;
}

/** SQLite persistence for model metadata and encrypted credentials. */
export class ModelStorage implements ModelStore {
  private readonly db: Database.Database;

  constructor(dbPath = process.env.DATABASE_PATH || path.resolve(process.cwd(), "data", "amd.db")) {
    if (dbPath !== ":memory:") {
      const directory = path.dirname(dbPath);
      fs.mkdirSync(directory, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        base_url TEXT,
        context_window INTEGER NOT NULL DEFAULT 4096,
        intelligence_score INTEGER NOT NULL DEFAULT 70,
        capabilities TEXT NOT NULL,
        cost_per_1k_tokens TEXT NOT NULL,
        max_tokens INTEGER NOT NULL,
        rate_limit TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_credentials (
        model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
        api_key TEXT NOT NULL,
        base_url TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled);
      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);
      CREATE INDEX IF NOT EXISTS idx_models_priority ON models(priority);
    `);
    // Databases created by the original scaffold lacked rate_limit; migrate them in place.
    try {
      this.db.exec(
        `ALTER TABLE models ADD COLUMN rate_limit TEXT NOT NULL DEFAULT '{"requestsPerMinute":0,"tokensPerDay":0}'`,
      );
    } catch {
      /* The column already exists. */
    }
    try {
      this.db.exec(`ALTER TABLE models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 4096`);
      this.db.exec(`UPDATE models SET context_window = max_tokens WHERE context_window = 4096 AND max_tokens > 4096`);
    } catch {
      /* The column already exists. */
    }
    try {
      this.db.exec(`ALTER TABLE models ADD COLUMN base_url TEXT`);
    } catch {
      /* The column already exists. */
    }
    try {
      this.db.exec(`ALTER TABLE models ADD COLUMN intelligence_score INTEGER NOT NULL DEFAULT 70`);
      this.db.exec(`
        UPDATE models
        SET intelligence_score = COALESCE(
          (SELECT json_extract(capability.value, '$.score')
           FROM json_each(models.capabilities) AS capability
           WHERE json_extract(capability.value, '$.type') = 'reasoning'
           LIMIT 1),
          70
        )
      `);
    } catch {
      /* The column already exists. */
    }
    // Older versions kept the endpoint beside the encrypted API key. Move it to
    // model metadata so models without credentials can still retain their URL.
    this.db.exec(`
      UPDATE models
      SET base_url = (
        SELECT base_url FROM model_credentials WHERE model_credentials.model_id = models.id
      )
      WHERE base_url IS NULL
        AND EXISTS (SELECT 1 FROM model_credentials WHERE model_credentials.model_id = models.id)
    `);
  }

  saveModel(config: ModelConfig): void {
    const save = this.db.transaction((model: ModelConfig) => {
      this.db
        .prepare(`
          INSERT INTO models (
            id, provider, name, model_id, base_url, context_window, intelligence_score, capabilities, cost_per_1k_tokens,
            max_tokens, rate_limit, enabled, priority, created_at, updated_at
          ) VALUES (@id, @provider, @name, @model_id, @base_url, @context_window, @intelligence_score, @capabilities, @cost_per_1k_tokens,
            @max_tokens, @rate_limit, @enabled, @priority, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            provider = excluded.provider,
            name = excluded.name,
            model_id = excluded.model_id,
            base_url = excluded.base_url,
            context_window = excluded.context_window,
            intelligence_score = excluded.intelligence_score,
            capabilities = excluded.capabilities,
            cost_per_1k_tokens = excluded.cost_per_1k_tokens,
            max_tokens = excluded.max_tokens,
            rate_limit = excluded.rate_limit,
            enabled = excluded.enabled,
            priority = excluded.priority,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `)
        .run({
          id: model.id,
          provider: model.provider,
          name: model.name,
          model_id: model.modelId,
          base_url: model.baseURL ?? null,
          context_window: model.contextWindow ?? model.maxTokens,
          intelligence_score: model.intelligenceScore ?? model.capabilities.find((capability) => capability.type === "reasoning")?.score ?? 70,
          capabilities: JSON.stringify(model.capabilities),
          cost_per_1k_tokens: JSON.stringify(model.costPer1kTokens),
          max_tokens: model.maxTokens,
          rate_limit: JSON.stringify(model.rateLimit),
          enabled: model.enabled ? 1 : 0,
          priority: model.priority,
          created_at: model.createdAt.toISOString(),
          updated_at: model.updatedAt.toISOString(),
        });

      if (model.apiKey) {
        this.db
          .prepare(`
            INSERT INTO model_credentials (model_id, api_key, base_url)
            VALUES (@model_id, @api_key, @base_url)
            ON CONFLICT(model_id) DO UPDATE SET
              api_key = excluded.api_key,
              base_url = excluded.base_url
          `)
          .run({
            model_id: model.id,
            api_key: encryptAPIKey(model.apiKey),
            base_url: model.baseURL ?? null,
          });
      } else {
        this.db.prepare("DELETE FROM model_credentials WHERE model_id = ?").run(model.id);
      }
    });
    save(cloneModelConfig(config));
  }

  loadModel(id: string): ModelConfig | undefined {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined;
    if (!row) return undefined;
    const credentials = this.db
      .prepare("SELECT model_id, api_key, base_url FROM model_credentials WHERE model_id = ?")
      .get(id) as CredentialRow | undefined;

    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      modelId: row.model_id,
      baseURL: row.base_url ?? credentials?.base_url ?? undefined,
      contextWindow: row.context_window || row.max_tokens,
      intelligenceScore: row.intelligence_score,
      capabilities: JSON.parse(row.capabilities),
      costPer1kTokens: JSON.parse(row.cost_per_1k_tokens),
      maxTokens: row.max_tokens,
      rateLimit: JSON.parse(row.rate_limit || '{"requestsPerMinute":0,"tokensPerDay":0}'),
      enabled: row.enabled === 1,
      priority: row.priority,
      apiKey: credentials ? decryptAPIKey(credentials.api_key) : "",
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /** Alias for callers that use the registry's getModel terminology. */
  getModel(id: string): ModelConfig | undefined {
    return this.loadModel(id);
  }

  getAllModels(): ModelConfig[] {
    const rows = this.db
      .prepare("SELECT id FROM models ORDER BY priority ASC, updated_at DESC")
      .all() as Array<{ id: string }>;
    return rows
      .map(({ id }) => this.loadModel(id))
      .filter((model): model is ModelConfig => Boolean(model));
  }

  deleteModel(id: string): void {
    this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

