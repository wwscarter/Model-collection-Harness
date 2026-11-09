import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.deepEqual([...m.histogram(['blue','red','blue'])],[['blue',2],['red',1]]); assert.equal(m.histogram([]).size,0);
