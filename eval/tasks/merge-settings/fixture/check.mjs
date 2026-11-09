import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
const base={a:1,b:true,c:3}; assert.deepEqual(m.mergeSettings(base,{a:0,b:false,c:undefined,d:null}),{a:0,b:false,c:3,d:null}); assert.deepEqual(base,{a:1,b:true,c:3});
