import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Database, FileKeyProvider } from '../records/api.ts';
import type { ListenInfo } from './api.ts';
import { createAssembly } from './assemble/hub.ts';
import { serve } from './main.ts';

type Input = { env: Record<string, string>; dataDir: string; failListen: boolean };
let owned: Database['pool'] | undefined;
const ended = new Map<Database['pool'], number>();
const idleTimers = new Set<ReturnType<typeof setTimeout>>();
let idleFired = 0;
const query = Database.prototype.query;
Database.prototype.query = (function (this: Database, ...args: Parameters<typeof query>) {
  if (String(args[0]).includes('FROM lease_registrations')) owned = this.pool;
  return query.apply(this, args);
}) as typeof query;
const end = Database.prototype.end;
Database.prototype.end = async function () { ended.set(this.pool, (ended.get(this.pool) ?? 0) + 1); await end.call(this); };
const timeout = globalThis.setTimeout, clear = globalThis.clearTimeout;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  const [callback, delay, ...callbackArgs] = args;
  if (delay !== 30_000 || !new Error().stack?.includes('/pg-pool/')) return timeout(...args);
  let timer: ReturnType<typeof setTimeout>;
  timer = timeout(() => { idleTimers.delete(timer); idleFired++; callback(...callbackArgs); }, 2 ** 31 - 1);
  idleTimers.add(timer);
  return timer;
}) as typeof setTimeout;
globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
  if (typeof timer === 'object') idleTimers.delete(timer);
  clear(timer);
}) as typeof clearTimeout;

process.once('message', async (input: Input) => {
  const stop = Promise.withResolvers<void>(), listening = Promise.withResolvers<ListenInfo>();
  const lines: string[] = [];
  const assembly = createAssembly({ requireVaultKey: false, checkSandbox: false, requireOsIsolation: false, log: () => {} });
  let token = '';
  const running = serve([], {
    io: { env: input.env, cwd: input.dataDir, stdout: line => lines.push(line), stderr: line => lines.push(line) },
    ensureDatabase: async () => {},
    keyProvider: () => new FileKeyProvider(join(input.dataDir, 'synthetic-lifecycle.key')),
    stopSignal: () => stop.promise,
    onListening: info => listening.resolve(info),
    assembly: async () => ({ assemble: async (config, records) => {
      const admin = await records.principals.bootstrapAdmin('synthetic-lifecycle-admin', { password: 'SyntheticLifecycle42!', mustChange: false });
      token = admin.token.token;
      const deps = await assembly(config, records);
      const packContext = deps.runs.packContext!.bind(deps.runs);
      const context = [{ pack: 'synthetic-lifecycle@1.0.0', run_context: { parts: ['leases'], lease_prefix: 'synthetic-lifecycle/' } }] as unknown as Parameters<typeof packContext>[1];
      deps.runs.packContext = (by) => packContext(by, context);
      if (input.failListen) await deps.runs.packContext(admin.user, context);
      return deps;
    } }),
  });
  try {
    if (!input.failListen) {
      const info = await Promise.race([listening.promise, running.then(code => { throw new Error(`serve ended before listening (${code})`); })]);
      const client = new Client({ name: 'synthetic-lifecycle-client', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(info.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        const result = await client.callTool({ name: 'list_task_packs', arguments: {} });
        if (result.isError) throw new Error('synthetic lease context read was refused');
      } finally { await client.close(); }
      stop.resolve();
    }
    const code = await running;
    process.send!({ stage: 'stopped', code, ownedConnected: owned !== undefined,
      ownedEnds: owned ? ended.get(owned) ?? 0 : 0, ownedTotal: owned?.totalCount, ownedIdle: owned?.idleCount,
      idleTimers: idleTimers.size, idleRefs: [...idleTimers].filter(timer => timer.hasRef()).length, idleFired,
      printedStopped: lines.some(line => line.includes('circle-hub 已停止')) });
    process.once('message', async (message: { cleanup: boolean }) => {
      if (message.cleanup && owned && !ended.has(owned)) await owned.end();
      process.disconnect();
    });
  } catch (error) {
    stop.resolve();
    process.send!({ stage: 'failed', error: error instanceof Error ? error.message : 'fixture failed' });
    if (owned && !ended.has(owned)) await owned.end();
    process.disconnect();
    process.exitCode = 1;
  }
});
