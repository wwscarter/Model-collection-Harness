import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.deepEqual(m.unique(['b','a','b','c','a']),['b','a','c']); assert.deepEqual(m.unique([]),[]);
