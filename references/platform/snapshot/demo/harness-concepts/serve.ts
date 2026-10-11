import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const here=path.dirname(new URL(import.meta.url).pathname);
const files:Record<string,string>={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer((req,res)=>{const file=files[new URL(req.url!,'http://127.0.0.1').pathname];if(!file){res.writeHead(404);res.end('Not found');return;}res.setHeader('Content-Type',types[path.extname(file)]);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");res.end(fs.readFileSync(path.join(here,'dist',file)));});
server.listen(Number(process.env.INFOSEC_DEMO_PORT??4180),'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`));
process.on('SIGTERM',()=>server.close());process.on('SIGINT',()=>server.close());
