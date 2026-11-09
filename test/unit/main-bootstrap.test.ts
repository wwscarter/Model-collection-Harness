import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelStorage } from '@core/storage/ModelStorage';
import { SessionStorage } from '@core/storage/SessionStorage';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import { RoutingService } from '@core/routing/RoutingService';
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

afterEach(() => { vi.restoreAllMocks(); });

describe('main context lifecycle', () => {
  it('initializes the shared rules loader and trust store in the app data directory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-rules-'));
    const context = createMainContext(directory, () => null);
    try {
      expect(context.trustStore.list()).toEqual([]);
      const rule = await context.rulesLoader.saveGlobal({ name: '工作约定', content: '使用简洁说明。', enabled: true });
      expect(rule.path).toBe(path.join(fs.realpathSync(directory), 'agent', 'rules', '工作约定.md'));
      expect((await context.rulesLoader.load()).rules).toMatchObject([{ name: '工作约定', content: '使用简洁说明。' }]);
    } finally {
      disposeMainContext(context);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes initialized stores and services when startup fails before returning a context', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-'));
    const modelClose = vi.spyOn(ModelStorage.prototype, 'close');
    const sessionClose = vi.spyOn(SessionStorage.prototype, 'close');
    const projectClose = vi.spyOn(ProjectStorage.prototype, 'close');
    const metricsClose = vi.spyOn(ObservabilityEngine.prototype, 'close');
    const routingDispose = vi.spyOn(RoutingService.prototype, 'dispose');
    vi.spyOn(ObservabilityEngine.prototype, 'recoverInterruptedRuns').mockImplementationOnce(() => { throw new Error('startup recovery failed'); });
    try {
      expect(() => createMainContext(directory, () => null)).toThrow('startup recovery failed');
      for (const cleanup of [modelClose, sessionClose, projectClose, metricsClose, routingDispose]) expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('assembles the Hook store with the same persistent trust grants as project Rules', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newai-startup-hooks-')));
    const context = createMainContext(directory, () => null);
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
      disposeMainContext(context);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
