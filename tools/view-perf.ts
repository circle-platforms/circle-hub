// Synthetic, reproducible cold-process view benchmark. No deployment, environment files or keychain.
// Usage: node tools/view-perf.ts /tmp/view-perf-run [--unplaced] [--profile] [--budget]
// --pressure is a diagnostic collection experiment only; it is not used by runtime code or budget acceptance.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Session } from 'node:inspector/promises';
import { Session as SyncInspector } from 'node:inspector';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { openRecords, FileKeyProvider, sha256Hex } from '../hub/records/index.ts';
import type { Principal } from '../hub/records/api.ts';
import type { ProductHandle } from '../hub/ports.ts';
import {createTestParserRegistry as createDefaultRegistry} from '../hub/testing/parsers.ts';
import { createKnowledge } from '../hub/knowledge/service.ts';
import { createKnowledgeReader } from '../hub/knowledge/api.ts';
import { FakePacks, FakeExternal, makeWorld, startPostgres, mindMap, casesProducer, DEFAULT_PRODUCERS, catalogXml } from '../hub/knowledge/test-support.ts';

// Production and the cold read share one clock. produced_at and a clarification deadline are fixed-width, so a live clock keeps the byte length and changes the digest.
const FROZEN = '2026-01-06T00:00:00.000Z';
const frozenNow = (): Date => new Date(FROZEN);
type Input = { config: Parameters<typeof openRecords>[0]; keyPath: string; product: ProductHandle; principal: Principal; build: string; directory: string; now: string; allocationProfile?: boolean;pressure?:boolean };
export type ViewPerfResult = { wallMs: number; maxRSSKiB: number; bytes: number; sha256: string; queries: number; sql: Record<string, { count: number; ms: number ;}>; phases: Record<string, number>; truncated: boolean; totalEntries: number; totalKeys: number; listed: number; totals: unknown ;};
// Accepted cold-reader peak, including imports and consumer decoding, plus the integrator's 15% regression allowance.
export const VIEW_PERF_RSS_LIMIT_KIB = Math.ceil(494_448 * 1.15);
const build = 'Rel_ACME_10_6_15';
const syntheticProducer = `export default function produce(input) {
  const entries=[];
  for(const doc of input.lists.cases) for(const node of doc.model.nodes) {
    if(!node.data.resource || !node.data.priority) continue;
    const i=Number(node.data.id.slice(5));
    if(!Number.isFinite(i))continue;
    const command='synthetic command '+String(i%6097).padStart(4,'0');
    entries.push({kind:'case',path:input.params?.unplaced?null:'/commands/synthetic/c'+String(i%6097).padStart(4,'0'),statement:node.text,data:{document:doc.model.nodes[0].data.id,node:'node-'+i,commands:[command],steps:'synthetic steps '.repeat(30)},fragments:[{slot:'cases',source:doc.sha256,parser:'kityminder@1',selector:node.selector}],applicability:null});
  }
  return {entries,warnings:[]};
}`;

export async function benchmarkView(directory: string, options: { profile?: boolean; budget?: boolean;unplaced?:boolean;pressure?:boolean; afterRead?: (world: Awaited<ReturnType<typeof makeWorld>>) => Promise<void> } = {}): Promise<ViewPerfResult> {
  if(options.pressure&&options.budget)throw new TypeError('diagnostic collection runs cannot establish budget acceptance');
  await mkdir(directory, { recursive: true });
  const postgres = await startPostgres();
  const w = await makeWorld(postgres, { now: frozenNow, pack: { functions: { 'cases.ts': syntheticProducer }, declaration: { catalogs: [], producers: [...(options.unplaced?DEFAULT_PRODUCERS:[]),casesProducer({ batch: 30,params:{unplaced:options.unplaced===true} })] } } });
  try {
    const documents: string[] = [];
    for (let d = 0; d < 1800; d++) {
      const id = `store:mindmap:synthetic-${d}`; documents.push(id);
      const cases = Array.from({ length: Math.floor((d + 1) * 49000 / 1800) - Math.floor(d * 49000 / 1800) }, (_, c) => { const i = Math.floor(d * 49000 / 1800) + c; return { id: `case-${i}`, text: '合成用例 ' + i + ' ' + '描述'.repeat(80) }; });
      w.external.set(id, { bytes: mindMap({ id: 'synthetic-document-' + String(d).padStart(4, '0'), line: '10.6' }, cases), mediaType: 'application/json' });
    }
    if(options.unplaced)w.external.set('site:tree:synthetic',{bytes:catalogXml({synthetic:Array.from({length:6097},(_,i)=>({name:'c'+String(i).padStart(4,'0')}))}),mediaType:'application/xml'});
    const produced = await w.knowledge.produceTree({ product: w.product, build: { name: build, family: 'ACME', line: '10.6', base: build, platform: null, built_at: null, released_at: null, sources: { cases: documents,...(options.unplaced?{tree:'site:tree:synthetic'}:{}) }, root: null } });
    assert.equal(produced.ok, true, produced.reason ?? '');
    assert.deepEqual([produced.entries+produced.unplaced, produced.nodes], [49_000+(options.unplaced?6097:0), 6100]);
    const input: Input = { config: { ...w.kit.config, database: w.kit.database }, keyPath: w.kit.keyProvider.path, product: w.product, principal: w.user, build, directory, now: FROZEN, pressure:options.pressure };
    const invoke = (runInput: Input) => new Promise<ViewPerfResult>((res, rej) => {
      const child = fork(fileURLToPath(import.meta.url), ['--worker'], { execArgv: options.profile ? ['--cpu-prof', `--cpu-prof-dir=${runInput.directory}`, '--heap-prof', `--heap-prof-dir=${runInput.directory}`] : [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      let answer: ViewPerfResult | undefined;
      child.on('message', m => { answer = m as ViewPerfResult; }); child.on('error', rej);
      child.on('exit', code => code === 0 && answer ? res(answer) : rej(new Error(`view benchmark worker exit ${code}`)));
      child.send(runInput);
    });
    const result = await invoke(input);
    // Optional synthetic follow-up (for example maintenance over frozen runs) while this exact fixture still exists.
    await options.afterRead?.(w);
    if (process.argv.includes('--interactive')) {
      console.log(JSON.stringify(result)); let iteration = 0;
      for await (const line of createInterface({ input: process.stdin })) {
        if (line.trim() === 'quit') break;
        const next = resolve(directory, `repeat-${++iteration}`); await mkdir(next, { recursive: true });
        const measured = await invoke({ ...input, directory: next, allocationProfile: line.trim() === 'allocations' }); await writeFile(resolve(next, 'result.json'), JSON.stringify(measured, null, 2)); console.log(JSON.stringify(measured));
      }
    }
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
    if (options.budget) {
      assert.ok(result.wallMs < 30_000, `cold view ${result.wallMs}ms (loose contention allowance)`);
      assert.ok(result.maxRSSKiB <= VIEW_PERF_RSS_LIMIT_KIB, `cold view RSS ${result.maxRSSKiB}KiB; regression limit ${VIEW_PERF_RSS_LIMIT_KIB}KiB`);
      assert.ok(result.queries <= 140, `cold view ${result.queries} queries`);
    }
    return result;
  } finally { await w.close(); await postgres.stop(); }
}

async function worker(input: Input): Promise<void> {
  const pressure=input.pressure?new SyncInspector():null;pressure?.connect();let collectedHeap=process.memoryUsage().heapUsed;
  let gcCalls=0,gcMs=0;
  const checkPressure=()=>{if(!pressure||process.memoryUsage().heapUsed<collectedHeap+16*1024*1024)return;const start=performance.now();pressure.post('HeapProfiler.collectGarbage');gcCalls++;gcMs+=performance.now()-start;collectedHeap=process.memoryUsage().heapUsed;};
  const now = () => new Date(input.now);
  const kit = await openRecords(input.config, { migrate: false, keyProvider: new FileKeyProvider(input.keyPath), now, onCredentialScan:pressure?checkPressure:undefined });
  const packs = new FakePacks(); packs.add(input.product); packs.readers.set(input.principal.id, new Set([input.product.id]));
  const knowledge = createKnowledge({ records: kit, packs, external: new FakeExternal(kit), parsers: createDefaultRegistry(), clock: now });
  const sql: ViewPerfResult['sql'] = {}; let queries = 0;
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string ;})?.text ?? 'unknown');
    const stat = sql[text] ??= { count: 0, ms: 0 }; stat.count++; queries++;
    const start = performance.now();
    const callback = args.at(-1);
    if (typeof callback === 'function') { args[args.length - 1] = function (this: unknown, ...values: unknown[]) { stat.ms += performance.now() - start; return Reflect.apply(callback, this, values); }; }
    const promise = Reflect.apply(original, this, args);
    if (promise && typeof promise.finally === 'function') return promise.finally(() => { stat.ms += performance.now() - start; });
    return promise;
  } as typeof original;
  const phases: Record<string, number> = {};
  const memory: Record<string, NodeJS.MemoryUsage> = { start: process.memoryUsage() };
  phases.startMaxRSSKiB = process.resourceUsage().maxRSS;
  const timed = (object: object, key: string) => { const methods = object as Record<string, (...args: unknown[]) => unknown>; const fn = methods[key]; methods[key] = async function (...args: unknown[]) { const start = performance.now(); try { return await fn.apply(object, args); } finally { phases[key] = (phases[key] ?? 0) + performance.now() - start; memory[key] = process.memoryUsage();checkPressure(); } }; };
  timed(knowledge.store, 'forEachRowsParts');timed(knowledge.store,'entries'); timed(kit.artifacts, 'prepareDerived'); timed(kit.artifacts, 'ingest'); timed(kit.artifacts, 'ingestTransferred');
  const profiler = input.allocationProfile ? new Session() : null;
  if (profiler) { profiler.connect(); await profiler.post('HeapProfiler.stopSampling').catch(() => { }); await profiler.post('HeapProfiler.startSampling', { samplingInterval: 65536, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
  const start = performance.now();
  try {
    const result = await createKnowledgeReader(knowledge).read(`knowledge:index:acme:${input.build}?kind=case&key=document&fields=commands,document,node`, { principal: input.principal, run: null, purpose: '合成性能基线' });
    assert.ok(result.ok, result.ok ? '' : result.reason);
    const wallMs = performance.now() - start;
    phases.afterReadMaxRSSKiB = process.resourceUsage().maxRSS; memory.afterRead = process.memoryUsage();
    if (profiler) { await profiler.post('HeapProfiler.collectGarbage'); memory.afterCollection = process.memoryUsage(); }
    phases.gcRequests=gcCalls;phases.gcDispatchMs=gcMs;
    const artifact = result.artifacts[0].artifact;
    const bytes = await kit.objects.get(artifact.body.sha256); assert.ok(bytes);
    const view = JSON.parse(Buffer.from(bytes).toString());
    const answer: ViewPerfResult = { wallMs, maxRSSKiB: process.resourceUsage().maxRSS, bytes: bytes.length, sha256: sha256Hex(bytes), queries, sql, phases, truncated: view.truncated, totalEntries: view.total_entries, totalKeys: view.total_keys, listed: Object.keys(view.entries).length, totals: view.totals };
    await writeFile(resolve(input.directory, 'memory.json'), JSON.stringify(memory, null, 2));
    await writeFile(resolve(input.directory, 'output.json'), bytes);
    process.send?.(answer);
  } finally { if (profiler) { const { profile } = await profiler.post('HeapProfiler.stopSampling'); await writeFile(resolve(input.directory, 'allocations.heapprofile'), JSON.stringify(profile)); profiler.disconnect(); } pressure?.disconnect();pg.Client.prototype.query = original; await kit.close(); process.disconnect?.(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--worker') process.once('message', m => void worker(m as Input).catch(e => { console.error(e); process.exitCode = 1; }));
  else console.log(JSON.stringify(await benchmarkView(resolve(process.argv[2] ?? '/tmp/hub-view-perf'), { profile: process.argv.includes('--profile'), budget: process.argv.includes('--budget'),unplaced:process.argv.includes('--unplaced'),pressure:process.argv.includes('--pressure') })));
}
