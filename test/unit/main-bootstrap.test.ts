import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelStorage } from '@core/storage/ModelStorage';
import { SessionStorage } from '@core/storage/SessionStorage';
import { ProjectStorage } from '@core/storage/ProjectStorage';
import { ObservabilityEngine } from '@core/observability/ObservabilityEngine';
import { RoutingService } from '@core/routing/RoutingService';
import { createMainContext } from '../../src/main/bootstrap';

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
});
