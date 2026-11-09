import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.deepEqual(m.range(2,5),[2,3,4,5]); assert.deepEqual(m.range(2,2),[2]); assert.deepEqual(m.range(4,2),[]);
