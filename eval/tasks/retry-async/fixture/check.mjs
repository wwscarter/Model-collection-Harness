import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
let count=0; assert.equal(await m.retry(async()=>{if(++count<3)throw Error('ordinary retry');return 'done'},3),'done'); assert.equal(count,3); let failures=0; await assert.rejects(m.retry(async()=>{failures++;throw Error('last')},2),/last/); assert.equal(failures,2);
