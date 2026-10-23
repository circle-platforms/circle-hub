import { createServer as createSecureServer, type ServerOptions } from 'node:https';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
export type StubCall = { method: string; params: Record<string, unknown>; headers: IncomingMessage['headers'] };
export async function startEndpoint(tools: string[], respond: (name: string, args: Record<string, unknown>, res: ServerResponse, id?: number) => unknown | Promise<unknown>, tls?: ServerOptions, inputSchemas: Record<string,Record<string,unknown>> = {},version:()=>string=()=> '1') {
  const calls: StubCall[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    let text = ''; for await (const chunk of req) text += String(chunk);
    const rpc = JSON.parse(text) as { id?: number; method: string; params?: Record<string, unknown> };
    calls.push({ method: rpc.method, params: rpc.params ?? {}, headers: req.headers });
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: version() } };
    else if (rpc.method === 'tools/list') result = { tools: tools.map(name => ({ name, inputSchema: inputSchemas[name] ?? { type: 'object' } })) };
    else { const value = await respond(String(rpc.params?.name), (rpc.params?.arguments ?? {}) as Record<string, unknown>, res, rpc.id); result = { structuredContent:value,content:[],...(value && typeof value==='object' && (value as Record<string,unknown>).ok===false ? {isError:true} : {}) }; }
    if (!res.headersSent && !res.destroyed) { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'synthetic-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); }
  };
  const server = tls ? createSecureServer(tls, handler) : createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, server, endpoint: `${tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
