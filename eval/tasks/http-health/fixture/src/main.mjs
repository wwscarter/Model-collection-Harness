import http from 'node:http'; export function createApp(){return http.createServer((req,res)=>{res.writeHead(404);res.end();});}
