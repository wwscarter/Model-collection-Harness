import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
const server=m.createApp(); await new Promise(r=>server.listen(0,'127.0.0.1',r)); try {const url='http://127.0.0.1:'+server.address().port; const health=await fetch(url+'/health'); assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'ok'});assert.equal((await fetch(url+'/missing')).status,404);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
