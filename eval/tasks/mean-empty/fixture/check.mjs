import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.equal(m.mean([2,4,9]),5); assert.equal(m.mean([]),null);
