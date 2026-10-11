import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = process.env.INFOSEC_LAB_ROOT!;
const role = process.argv[2];
const require = createRequire(path.join(root, 'runtime/package.json'));
const { Server } = require('ssh2');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'private/runtime.json'), 'utf8'));
const eventsFile = path.join(root, 'evidence/events.jsonl');
const children = new Set<any>();
const sockets = new Set<any>();
const servers: any[] = [];
const record = (kind: string, details: Record<string, unknown> = {}) => fs.appendFileSync(eventsFile, JSON.stringify({ runId: runtime.runId, at: new Date().toISOString(), role, pid: process.pid, kind, ...details }) + '\n');
const retain = (socket: any) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', (error: any) => record('socket-error', { code: error.code, message: error.message })); return socket; };
async function listen(server: any) { servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
function startMessage(data: Record<string, unknown>) { record('ready', data); process.stdout.write(JSON.stringify({ role, pid: process.pid, ...data }) + '\n'); }
const saveState = (state: any) => { const file = path.join(root, 'private/device-state.json'); fs.writeFileSync(file + '.new', JSON.stringify(state)); fs.renameSync(file + '.new', file); };
const stateFile = path.join(root, 'private/device-state.json');
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { identity: 'lab-device-01', revision: 1, mutations: 0, backendPort: 0, operations: {} };
function configure(port: number, operationId: string, dropReceipt = false) {
  if (state.operations[operationId]) { if (state.operations[operationId].port !== port) throw new Error('operation-id-conflict'); return { ...state.operations[operationId], duplicate: true }; }
  state.backendPort = port; state.revision++; state.mutations++;
  const result = { operationId, port, revision: state.revision, mutations: state.mutations };
  state.operations[operationId] = result; saveState(state);
  record('configuration-applied', result);
  if (dropReceipt) record('receipt-deliberately-lost', { operationId });
  return result;
}
async function readBody(req: any) { let body = ''; for await (const chunk of req) { body += chunk.toString('utf8'); if (body.length > 65536) throw new Error('payload-too-large'); } return body ? JSON.parse(body) : {}; }
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Isolated Research Lab</title><style>body{font:16px system-ui;margin:40px;background:#f5f7fa;color:#142334}main{max-width:720px;background:white;padding:28px;border-radius:14px}button,input{font:inherit;padding:10px;margin:8px}pre{background:#eef2f6;padding:18px;white-space:pre-wrap}</style></head><body><main><h1>Isolated Research Lab</h1><p>Synthetic device only. No production network.</p><label>Backend port <input id="port" type="number"></label><button id="apply">Apply configuration</button><pre id="state">Loading</pre><p id="message"></p></main><script>async function refresh(){const s=await fetch('/state').then(r=>r.json());document.querySelector('#state').textContent=JSON.stringify(s,null,2);document.querySelector('#port').value=s.backendPort;return s}document.querySelector('#apply').onclick=async()=>{const port=Number(document.querySelector('#port').value);const r=await fetch('/configure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port,operationId:'browser-'+crypto.randomUUID()})});document.querySelector('#message').textContent=r.ok?'Configuration accepted':'Configuration failed';await refresh()};refresh()</script></body></html>`;
if (role === 'backend') {
  const server = http.createServer((req, res) => { record('business-request', { method: req.method, url: req.url }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ role: 'lab-business-backend', ok: true, requestId: req.headers['x-lab-request'] ?? null })); });
  server.on('connection', retain); startMessage({ port: await listen(server) });
} else if (role === 'device') {
  const manager = http.createServer(async (req, res) => {
    try {
      record('management-request', { method: req.method, url: req.url });
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(page); return; }
      if (req.url === '/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return; }
      if (req.url === '/configure' && req.method === 'POST') { const input = await readBody(req); if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || typeof input.operationId !== 'string') throw new Error('invalid-config'); const result = configure(input.port, input.operationId, !!input.dropReceipt); if (input.dropReceipt) { req.socket.destroy(); return; } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return; }
      if (req.url === '/identity-drift' && req.method === 'POST') { state.identity = (await readBody(req)).identity; saveState(state); res.end('{}'); return; }
      res.statusCode = 404; res.end('not found');
    } catch (error: any) { res.statusCode = 409; res.end(JSON.stringify({ error: error.message })); }
  });
  manager.on('connection', retain);
  const managementPort = await listen(manager);
  const frontend = http.createServer((req, res) => {
    const requestId = String(req.headers['x-lab-request'] ?? 'unassigned');
    record('business-forward', { requestId, backendPort: state.backendPort });
    const upstream = http.request({ hostname: '127.0.0.1', port: state.backendPort, path: req.url, headers: { 'x-lab-request': requestId }, timeout: 1200 }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    upstream.on('error', (error: any) => { record('business-forward-failed', { requestId, backendPort: state.backendPort, code: error.code, message: error.message }); if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, code: error.code })); });
    upstream.on('timeout', () => upstream.destroy(new Error('backend-timeout'))); req.pipe(upstream);
  });
  frontend.on('connection', retain);
  const businessPort = await listen(frontend);
  const ssh = new Server({ hostKeys: [fs.readFileSync(path.join(root, 'private/device-hostkey'))] }, (client: any) => {
    client.on('error', (error: any) => record('ssh-error', { message: error.message }));
    client.on('authentication', (ctx: any) => ctx.method === 'password' && ctx.username === 'lab' && ctx.password === runtime.secret ? ctx.accept() : ctx.reject());
    client.on('ready', () => { record('ssh-authenticated'); client.on('session', (accept: any) => {
      const session = accept();
      session.on('exec', (acceptExec: any, _reject: any, info: any) => {
        const stream = acceptExec(); const command = String(info.command); record('ssh-command', { command });
        try {
          if (command === 'show identity') stream.end(JSON.stringify({ identity: state.identity, revision: state.revision }) + '\r\n');
          else if (command === 'show config') stream.end(JSON.stringify({ backendPort: state.backendPort, mutations: state.mutations, revision: state.revision }) + '\r\n');
          else if (command.startsWith('configure ')) { const [, port, operationId, fault] = command.split(' '); const result = configure(Number(port), operationId, fault === 'drop-receipt'); if (fault === 'drop-receipt') { client.end(); return; } stream.end(JSON.stringify(result) + '\r\n'); }
          else if (command === 'show long-output') { for (let i = 0; i < 2000; i++) stream.write(`line-${i.toString().padStart(4, '0')} synthetic-output\r\n`); stream.end('lab-device#\r\n'); }
          else if (command.startsWith('run delayed ')) { const id = command.split(' ')[2]; if (!/^[a-z0-9-]+$/.test(id)) throw new Error('invalid-job-id'); const child = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'remote-job.ts'), id], { env: { PATH: process.env.PATH!, INFOSEC_LAB_ROOT: root }, stdio: 'ignore' }); children.add(child); child.on('exit', () => children.delete(child)); record('remote-job-started', { jobId: id, childPid: child.pid }); stream.write(JSON.stringify({ jobId: id, childPid: child.pid }) + '\r\n'); child.on('exit', () => { if (!stream.destroyed) stream.end('job finished\r\n'); }); }
          else { stream.stderr.write('unsupported lab command\r\n'); stream.exit(2); stream.end(); }
        } catch (error: any) { stream.stderr.write(error.message + '\r\n'); stream.exit(1); stream.end(); }
      });
    }); });
  });
  startMessage({ managementPort, businessPort, sshPort: await listen(ssh) });
} else if (role === 'jump') {
  const targetPort = Number(process.argv[3]);
  const ssh = new Server({ hostKeys: [fs.readFileSync(path.join(root, 'private/jump-hostkey'))] }, (client: any) => {
    client.on('error', (error: any) => record('ssh-error', { message: error.message }));
    client.on('authentication', (ctx: any) => ctx.method === 'password' && ctx.username === 'lab' && ctx.password === runtime.secret ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('tcpip', (accept: any, reject: any, info: any) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== targetPort) { record('forward-refused', { requestedPort: info.destPort }); reject(); return; }
      const upstream = retain(net.connect({ host: '127.0.0.1', port: targetPort }));
      upstream.once('connect', () => { const channel = retain(accept()); record('forward-established', { targetPort }); channel.pipe(upstream).pipe(channel); channel.on('close', () => upstream.destroy()); });
      upstream.once('error', () => reject());
    }));
  });
  startMessage({ port: await listen(ssh), targetPort });
} else throw new Error('Unknown lab role');

async function stop() { record('shutdown-start'); for (const child of children) child.kill('SIGTERM'); for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); record('shutdown-complete'); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
