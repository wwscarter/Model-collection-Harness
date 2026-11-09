import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.equal(m.sum([2,-1,5]),6); assert.equal(m.sum([]),0);
