import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
assert.deepEqual(m.paginate([1,2,3,4,5],1,2),[1,2]);
assert.deepEqual(m.paginate([1,2,3,4,5],2,2),[3,4]);
assert.deepEqual(m.paginate([1,2,3,4,5],3,2),[5]);
assert.deepEqual(m.paginate([1,2,3,4,5],2,3),[4,5]);
assert.deepEqual(m.paginate([1],2,2),[]);
assert.deepEqual(m.paginate([],1,2),[]);
