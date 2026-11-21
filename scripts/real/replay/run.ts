import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectBundle, privateDirectory, safeFile, writePrivate } from './bundle.ts';
import { canonical, sha } from './types.ts';
import type { PlayOptions, ReplayReport } from './player.ts';
export async function runReplay(options: {
  bundle: string;
  app: string;
  out: string;
  timeoutMs?: number;
} & PlayOptions): Promise<ReplayReport> {
  const b = inspectBundle(options.bundle);
  const sourceSha256 = sha(safeFile(b.directory, 'source.json'));
  const adapterFiles = ['types.ts', 'bundle.ts', 'player.ts', 'run.ts', 'worker.ts'];
  const adapterSha256 = sha(canonical(Object.fromEntries(adapterFiles.map(file => [file, sha(readFileSync(new URL(file, import.meta.url)))]))));
  const out = privateDirectory(options.out, [b.directory, b.source.home, ...b.source.workspaces, options.app]);
  const report = await new Promise<ReplayReport>((resolve) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { bundle: b.directory, sourceSha256, app: options.app, options: { pace: options.pace, speed: options.speed } }, env: { CIRCLE_NO_MODELS_REFRESH: '1', CIRCLE_NO_UPDATE_CHECK: '1', CIRCLE_DISABLE_HOOKS: '0', CIRCLE_HOME: join(out, 'unused-home') }, execArgv: [] });
    let finished = false;
    const complete = (result: ReplayReport) => {
      if (finished)
        return; finished = true; clearTimeout(timer); void worker.terminate().then(() => resolve(result));
    };
    const failed = (fact: string, exit: number, detail: Record<string, unknown> = {}) => ({ schema: 'circle-replay-report@1', status: exit === 2 ? 'unavailable' : 'different', exit, expected: b.counts, actual: null, gaps: b.gaps, coverage: { harness: 'worker_failure' }, firstDifference: { fact, ...detail } } as ReplayReport);
    const timer = setTimeout(() => complete(failed('回放达到注入的运行限额，未证明完成', 2)), options.timeoutMs ?? 120000);
    worker.once('message', result => complete(result?.schema === 'circle-replay-report@1' ? result : failed('回放线程没有交付完整报告', result?.exit === 2 ? 2 : 1)));
    worker.once('error', error => complete(failed('回放线程异常', 1, { errorSha256: sha(error.message) })));
    worker.once('exit', code => {
      if (!finished)
        complete(failed('回放线程没有交付报告', 1, { code }));
    });
  });
  report.coverage.sourceSha256 = sourceSha256;
  report.coverage.adapterSha256 = adapterSha256;
  if (report.trace) {
    const trace = report.trace.map(event => JSON.stringify(event)).join('\n') + '\n';
    writePrivate(out, 'trace.jsonl', trace);
    report.coverage.traceSha256 = sha(trace);
    delete report.trace;
  }
  writePrivate(out, 'report.json', JSON.stringify(report, null, 2) + '\n');
  writePrivate(out, 'summary.txt', `状态：${report.status}\n消息：${report.actual?.messages ?? '未知'}\n调用：${report.actual?.calls ?? '未知'}\n报告摘要：${sha(canonical(report))}\n`);
  return report;
}
