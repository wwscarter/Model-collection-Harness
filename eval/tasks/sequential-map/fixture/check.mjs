import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
let active=0, peak=0; const result=await m.mapSeries([1,2,3],async x=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,3));active--;return x*2}); assert.deepEqual(result,[2,4,6]); assert.equal(peak,1);
