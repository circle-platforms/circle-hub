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
      if (request.method === 'POST' && request.url === '/v1/judge') {
        let parsed: { task?: string; questions?: Record<string, { task?: string; candidates?: Array<{ name?: string }> }> };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        const answers: Record<string, unknown> = {};
        for (const [qid, q] of Object.entries(parsed.questions ?? {})) {
          const task = q.task ?? parsed.task;
          if (task === 'choice') {
            const picked = q.candidates?.[0]?.name ?? 'ip address';
            answers[qid] = { status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', answer: { type: 'choice', value: picked, confidence: 0.93, probabilities: { [picked]: 0.93, 都不是: 0.07 } }, gate: { action: 'pass', calibrated: true } };
          } else if (task === 'sequence') {
            answers[qid] = { status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', answer: { type: 'choice', value: '保持', confidence: 0.94, probabilities: { 保持: 0.94, 改变: 0.04, 未实现: 0.02 } }, gate: { action: 'pass', calibrated: true } };
          } else {
            answers[qid] = { status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', answer: { type: 'noul', value: 'yes', match: 1, probabilities: { yes: 0.92, no: 0.08 } }, gate: { action: 'pass', calibrated: true } };
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', task: parsed.task, request_id: 'syn-plumb-1', answers }));
        return;
      }
      if (request.method === 'POST') {
        let valid = false;
        try {
          const rpc = JSON.parse(body);
          valid = rpc.jsonrpc === '2.0' && rpc.method === 'tools/call' && rpc.params?.name === 'submit_result' && rpc.params.arguments?.run === configuration.run && Array.isArray(rpc.params.arguments.items) && rpc.params.arguments.items.length === 1;
        } catch { }
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
