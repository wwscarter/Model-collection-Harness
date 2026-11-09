import fs from 'node:fs';import assert from 'node:assert/strict';const s=JSON.parse(fs.readFileSync('settings.json','utf8'));assert.deepEqual(s,{display:{theme:'dark',fontSize:16},recentLimit:10});
