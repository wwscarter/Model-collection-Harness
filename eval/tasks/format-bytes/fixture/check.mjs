import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.equal(m.formatBytes(0),'0 B'); assert.equal(m.formatBytes(1536),'1.5 KiB'); assert.equal(m.formatBytes(1048576),'1.0 MiB');
