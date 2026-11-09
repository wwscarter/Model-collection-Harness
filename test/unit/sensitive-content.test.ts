import { describe, expect, it } from 'vitest';
import { containsSensitiveContent, hasSensitiveContent } from '@core/security/sensitiveContent';

// All fixtures below are deliberately synthetic strings, never usable credentials.
const synthetic = [
  'SYNTHETIC TEST DATA ONLY: sk-synthetic-placeholder-000000',
  'SYNTHETIC TEST DATA ONLY: api_key=synthetic-placeholder',
  'SYNTHETIC TEST DATA ONLY: BEGIN RSA PRIVATE KEY (NO KEY DATA)',
  'SYNTHETIC TEST DATA ONLY: BEGIN PRIVATE KEY (NO KEY DATA)',
  'SYNTHETIC TEST DATA ONLY: AKIA' + 'SYNTHETIC0000000'.padEnd(16, '0'),
  'SYNTHETIC TEST DATA ONLY: ghp_synthetictestdataonly000000',
  'SYNTHETIC TEST DATA ONLY: xoxb-synthetic-placeholder',
];
describe('shared sensitive-content checks', () => {
  it.each(synthetic)('flags explicitly synthetic credential-shaped metadata', (content) => {
    expect(containsSensitiveContent(content)).toBe(true);
    expect(hasSensitiveContent(content)).toBe(true);
  });
  it.each(['Prefer short comments.', 'Use environment variables for configuration.', 'Explain test results in Chinese.', 'API credentials belong in the app settings.'])('allows ordinary rule text', (content) => {
    expect(containsSensitiveContent(content)).toBe(false);
  });
});
