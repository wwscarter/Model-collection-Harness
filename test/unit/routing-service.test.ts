import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoutingService } from '@core/routing/RoutingService';
import { DEFAULT_ROUTING_SETTINGS } from '@core/routing/RoutingSettings';

const directories: string[] = [];
const services: RoutingService[] = [];
function create() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-routing-service-'));
  directories.push(directory);
  const file = path.join(directory, 'routing-settings.json');
  const service = new RoutingService(file);
  services.push(service);
  return { directory, file, service };
}
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('RoutingService', () => {
  it('starts without Ollama, returns isolated configuration snapshots, and classifies with rules', async () => {
    const { service } = create();
    const draft = service.getConfiguration();
    expect(draft.settings.classifier.mode).toBe('rules');
    draft.settings.classifier.mode = 'ollama';
    expect(service.getConfiguration().settings.classifier.mode).toBe('rules');
    expect(await service.classify({ type: 'general', description: '请修复 TypeScript API bug' })).toMatchObject({ taskType: 'code', backend: 'heuristic' });
  });

  it('persists settings for subsequent launches without downloading or registering execution models', () => {
    const { file, service } = create();
    const settings = structuredClone(DEFAULT_ROUTING_SETTINGS);
    settings.classifier.mode = 'ollama';
    settings.planning.mode = 'off';
    const saved = service.save(settings);
    expect(saved.status).toMatchObject({ backend: 'ollama', available: false });
    const reloaded = new RoutingService(file); services.push(reloaded);
    expect(reloaded.getConfiguration().settings).toEqual(saved.settings);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(saved.settings);
  });

  it('retains the active configuration if disk persistence fails', () => {
    const { file, service } = create();
    const before = service.getConfiguration();
    fs.mkdirSync(file);
    const changed = structuredClone(DEFAULT_ROUTING_SETTINGS); changed.classifier.mode = 'ollama';
    expect(() => service.save(changed)).toThrow();
    expect(service.getConfiguration()).toEqual(before);
  });

  it('rejects a remote endpoint without changing the active or saved configuration', () => {
    const { file, service } = create();
    service.save(DEFAULT_ROUTING_SETTINGS);
    const prior = fs.readFileSync(file, 'utf8');
    const changed = structuredClone(DEFAULT_ROUTING_SETTINGS); changed.classifier.baseURL = 'https://remote.example.com';
    expect(() => service.save(changed)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(prior);
    expect(service.getConfiguration().settings.classifier.baseURL).toBe(DEFAULT_ROUTING_SETTINGS.classifier.baseURL);
  });
});
