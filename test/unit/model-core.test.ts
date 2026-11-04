import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureEncryptionKeyProvider,
  createElectronSafeStorageKeyProvider,
  decryptAPIKey,
  encryptAPIKey,
  resetEncryptionKeyProvider,
} from "../../src/utils/crypto";
import { ModelRegistry } from "../../src/core/models/ModelRegistry";
import { ModelConfig } from "../../src/core/models/ModelConfig";
import { ModelStorage } from "../../src/core/storage/ModelStorage";

const testKey = Buffer.alloc(32, 7);

function sampleModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "test-model",
    provider: "openai",
    name: "Test model",
    apiKey: "sk-secret",
    modelId: "test-model-v1",
    costPer1kTokens: { input: 0.01, output: 0.02 },
    capabilities: [{ type: "code", score: 90 }],
    maxTokens: 4096,
    rateLimit: { requestsPerMinute: 10, tokensPerDay: 100_000 },
    enabled: true,
    priority: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => resetEncryptionKeyProvider());

describe("API key encryption", () => {
  it("fails closed when no persistent key source is configured", () => {
    expect(() => encryptAPIKey("sk-test-secret")).toThrow(/persistent encryption key/);
  });

  it("round trips with an injected stable key", () => {
    configureEncryptionKeyProvider(() => testKey);
    const encrypted = encryptAPIKey("sk-test-secret");
    expect(encrypted).not.toContain("sk-test-secret");
    expect(decryptAPIKey(encrypted)).toBe("sk-test-secret");
  });

  it("persists an encryption key through Electron safeStorage", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-safe-storage-"));
    const keyPath = path.join(tempDir, "wrapped.key");
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`wrapped:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").slice("wrapped:".length),
    };
    const providerA = createElectronSafeStorageKeyProvider({ keyPath, safeStorage });
    const providerB = createElectronSafeStorageKeyProvider({ keyPath, safeStorage });
    expect(providerA()).toEqual(providerB());
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("ModelStorage", () => {
  it("persists metadata and decrypts credentials after reopening", () => {
    configureEncryptionKeyProvider(() => testKey);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-models-"));
    const dbPath = path.join(tempDir, "models.db");
    const first = new ModelStorage(dbPath);
    first.saveModel(sampleModel());
    first.close();

    const reopened = new ModelStorage(dbPath);
    const loaded = reopened.loadModel("test-model");
    expect(loaded?.apiKey).toBe("sk-secret");
    expect(loaded?.capabilities).toEqual([{ type: "code", score: 90 }]);
    reopened.deleteModel("test-model");
    expect(reopened.loadModel("test-model")).toBeUndefined();
    reopened.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps loading when one credential cannot be decrypted", () => {
    configureEncryptionKeyProvider(() => testKey);
    const storage = new ModelStorage(":memory:");
    storage.saveModel(sampleModel());
    (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
      .prepare("UPDATE model_credentials SET api_key = ? WHERE model_id = ?")
      .run("00:00:00", "test-model");

    const loaded = storage.loadModel("test-model");
    expect(loaded?.apiKey).toBe("");
    expect(loaded?.credentialError).toContain("解密失败");
    // The registry (and therefore app bootstrap) must survive the damage.
    const registry = new ModelRegistry(storage, { initializePresets: false, persist: true });
    expect(registry.getModel("test-model")?.credentialError).toBeTruthy();
    registry.updateModel("test-model", { apiKey: "sk-replaced" });
    expect(registry.getModel("test-model")?.credentialError).toBeUndefined();
    expect(registry.getModel("test-model")?.apiKey).toBe("sk-replaced");
    storage.close();
  });

  it("persists a custom endpoint and model metadata without an API key", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amd-custom-model-"));
    const dbPath = path.join(tempDir, "models.db");
    const first = new ModelStorage(dbPath);
    first.saveModel(sampleModel({
      provider: "custom",
      apiKey: "",
      baseURL: "http://127.0.0.1:8080/v1",
      contextWindow: 32_000,
      intelligenceScore: 86,
    }));
    first.close();

    const reopened = new ModelStorage(dbPath);
    expect(reopened.loadModel("test-model")).toMatchObject({
      apiKey: "",
      baseURL: "http://127.0.0.1:8080/v1",
      contextWindow: 32_000,
      intelligenceScore: 86,
    });
    reopened.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("ModelRegistry", () => {
  it("selects the highest scoring enabled model for a capability", async () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    registry.registerModel(sampleModel({ id: "slow", name: "Slow", capabilities: [{ type: "code", score: 50 }] }));
    registry.registerModel(sampleModel({ id: "strong", name: "Strong", capabilities: [{ type: "code", score: 99 }] }));
    expect((await registry.getModelForCapability("code"))?.id).toBe("strong");
  });

  it("updates and deletes models without exposing mutable internal state", () => {
    const registry = new ModelRegistry(undefined, { initializePresets: false, persist: false });
    registry.registerModel(sampleModel());
    const read = registry.getModel("test-model");
    read!.name = "mutated outside registry";
    expect(registry.getModel("test-model")?.name).toBe("Test model");
    expect(registry.updateModel("test-model", { enabled: false })?.enabled).toBe(false);
    expect(registry.deleteModel("test-model")).toBe(true);
    expect(registry.deleteModel("test-model")).toBe(false);
  });

  it("hydrates a second registry from the same storage", () => {
    configureEncryptionKeyProvider(() => testKey);
    const storage = new ModelStorage(":memory:");
    const first = new ModelRegistry(storage, { initializePresets: false, persist: true });
    first.registerModel(sampleModel());
    const second = new ModelRegistry(storage, { initializePresets: false, persist: true });
    expect(second.getModel("test-model")?.apiKey).toBe("sk-secret");
    storage.close();
  });
});

