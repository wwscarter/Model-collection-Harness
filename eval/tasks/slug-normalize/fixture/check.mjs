import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.equal(m.slug('  Hello, WORLD! '),'hello-world'); assert.equal(m.slug('---'),'');
