import assert from 'node:assert/strict';
import * as m from './src/main.mjs';
const rows=[{team:'a',id:1},{team:'b',id:2},{team:'a',id:3}]; assert.deepEqual([...m.groupBy(rows,'team')],[['a',[rows[0],rows[2]]],['b',[rows[1]]]]);
