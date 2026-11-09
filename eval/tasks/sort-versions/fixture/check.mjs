import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
const input=['1.10','1.2','2','1.2.1']; assert.deepEqual(m.sortVersions(input),['1.2','1.2.1','1.10','2']); assert.deepEqual(input,['1.10','1.2','2','1.2.1']);
