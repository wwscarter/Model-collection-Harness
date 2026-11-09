import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelStorage } from '@core/storage/ModelStorage';
import { SessionStorage } from '@core/storage/SessionStorage';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import { RoutingService } from '@core/routing/RoutingService';
import { ModelRegistry } from '@core/models/ModelRegistry';
import { safeStorage } from 'electron';
import { createMainContext, disposeMainContext } from '../../src/main/bootstrap';

vi.mock('electron', () => ({
  app: {},
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('main context lifecycle', () => {
  it('initializes the shared rules loader and trust store in the app data directory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-rules-'));
    const context = await createMainContext(directory, () => null);
    try {
      expect(context.trustStore.list()).toEqual([]);
      const rule = await context.rulesLoader.saveGlobal({ name: '工作约定', content: '使用简洁说明。', enabled: true });
      expect(rule.path).toBe(path.join(fs.realpathSync(directory), 'agent', 'rules', '工作约定.md'));
      expect((await context.rulesLoader.load()).rules).toMatchObject([{ name: '工作约定', content: '使用简洁说明。' }]);
    } finally {
      await disposeMainContext(context);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes initialized stores when startup fails before returning a context', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-'));
    const modelClose = vi.spyOn(ModelStorage.prototype, 'close');
    const sessionClose = vi.spyOn(SessionStorage.prototype, 'close');
    const projectClose = vi.spyOn(ProjectStorage.prototype, 'close');
    const metricsClose = vi.spyOn(ObservabilityEngine.prototype, 'close');
    const routingDispose = vi.spyOn(RoutingService.prototype, 'dispose');
    vi.spyOn(ModelRegistry.prototype, 'getEnabledModels').mockImplementationOnce(() => { throw new Error('startup registry failed'); });
    try {
      await expect(createMainContext(directory, () => null)).rejects.toThrow('startup registry failed');
      for (const cleanup of [modelClose, sessionClose, projectClose]) expect(cleanup).toHaveBeenCalledOnce();
      expect(metricsClose).not.toHaveBeenCalled();
      expect(routingDispose).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('assembles the Hook store with the same persistent trust grants as project Rules', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-hooks-')));
    const context = await createMainContext(directory, () => null);
    try {
      const config = { version: 1, hooks: [{ id: 'lint', event: 'run_start', run: 'npm run lint' }] };
      await context.hookStore.saveGlobal(config);
      expect((await context.hookStore.list()).global).toMatchObject({ path: path.join(directory, 'agent', 'hooks.json'), trusted: true, config });
      const project = path.join(directory, 'project');
      fs.mkdirSync(path.join(project, '.newai'), { recursive: true });
      fs.writeFileSync(path.join(project, '.newai', 'hooks.json'), JSON.stringify(config));
      const preview = (await context.hookStore.list(project)).project!;
      expect(preview.trusted).toBe(false);
      await context.hookStore.trustProject(project, preview.hash);
      expect(context.trustStore.isTrusted(project, '.newai/hooks.json', preview.hash)).toBe(true);
      expect((await context.hookStore.load(project)).hooks.map((hook) => hook.source)).toEqual(['global', 'project']);
    } finally {
      await disposeMainContext(context);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('assembles skill, masked MCP and tool trust stores under the app data directory', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-extensions-')));
    const context = await createMainContext(directory, () => null);
    try {
      expect(context.skillManager.skillsDir).toBe(path.join(directory, 'agent', 'skills'));
      expect(context.mcpConfig.filePath).toBe(path.join(directory, 'agent', 'mcp.json'));
      context.mcpConfig.save('local-docs', { type: 'http', url: 'http://127.0.0.1:34567/mcp', headers: { Authorization: 'synthetic-startup-only' } });
      expect(context.mcpConfig.list().servers[0].config).toMatchObject({ headers: { Authorization: '••••••' } });
      context.toolTrust.set('read', 'ask');
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'agent', 'tool-trust.json'), 'utf8'))).toMatchObject({ tools: { read: 'ask' } });
      expect(context.mcpTools).toEqual(new Map());
    } finally {
      await disposeMainContext(context);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts with visible credential errors when the OS keyring becomes unavailable', async () => {
    vi.stubEnv('AMD_ENCRYPTION_KEY', undefined);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-keyring-'));
    const first = await createMainContext(directory, () => null);
    const model = first.registry.getAllModels()[0];
    first.registry.updateModel(model.id, { apiKey: 'synthetic-persistent-only' });
    await disposeMainContext(first);
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    const unavailable = await createMainContext(directory, () => null);
    try {
      expect(unavailable.registry.getModel(model.id)).toMatchObject({ apiKey: '', credentialError: expect.stringContaining('解密失败') });
      expect(() => unavailable.registry.updateModel(model.id, { apiKey: 'synthetic-new-only' })).toThrow('encryption is unavailable');
    } finally { await disposeMainContext(unavailable); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves another host live metrics when opening the same data directory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-shared-host-'));
    const metrics = new ObservabilityEngine(path.join(directory, 'metrics.db'));
    metrics.saveTraceRun({ id: 'other-host-run', sessionId: 'ordinary-session', status: 'running', startedAt: new Date().toISOString(), totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 });
    const context = await createMainContext(directory, () => null);
    try { expect(context.observability.getTrace('other-host-run')?.run).toMatchObject({ id: 'other-host-run', status: 'running' }); }
    finally { await disposeMainContext(context); metrics.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
