import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.equal(m.wordCount('  a   b  c  '),3); assert.equal(m.wordCount('   '),0);
