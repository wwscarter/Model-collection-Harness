import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.equal(m.formatDate(new Date('2026-01-03T23:59:00Z')),'2026-01-03'); assert.equal(m.formatDate(new Date('2026-11-09T00:00:00Z')),'2026-11-09');
