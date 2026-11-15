// A separate process keeps the synthetic loopback responder live while the parent probes with spawnSync.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

interface Route { status: number; body: string; contentType?: string }
interface Configuration { token: string; run: string; receipt: string; routes: Record<string, Route> }
process.once('message', (configuration: Configuration) => {
  const server = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${configuration.token}`;
    const key = `${request.method} ${request.url}`;
    appendFileSync(configuration.receipt, JSON.stringify({ method: request.method, path: request.url, authorized }) + '\n');
    if (!authorized) { response.writeHead(401); response.end(); return; }
    const route = configuration.routes[key];
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'POST') {
        let valid = false;
        try {
          const rpc = JSON.parse(body);
          valid = rpc.jsonrpc === '2.0' && rpc.method === 'tools/call' && rpc.params?.name === 'submit_result' && rpc.params.arguments?.run === configuration.run && Array.isArray(rpc.params.arguments.items) && rpc.params.arguments.items.length === 1;
        } catch { /* Invalid synthetic calls receive an explicit protocol refusal below. */ }
        if (!valid) { response.writeHead(400); response.end(); return; }
      }
      response.writeHead(route?.status ?? 404, { 'content-type': route?.contentType ?? 'application/json' });
      response.end(route?.body ?? '');
    });
  });
  server.listen(0, '127.0.0.1', () => {
    process.send!({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  });
  process.once('disconnect', () => { server.closeAllConnections(); server.close(); });
});
