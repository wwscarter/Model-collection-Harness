import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.deepEqual(m.chunk([1,2,3,4,5],2),[[1,2],[3,4],[5]]); assert.deepEqual(m.chunk([],3),[]);
