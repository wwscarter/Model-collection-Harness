import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.equal(m.clamp(5,0,10),5); assert.equal(m.clamp(-1,0,10),0); assert.equal(m.clamp(11,0,10),10);
