// Local read-only capture and inert Harness replay. Raw evidence stays in explicit private directories outside Git.
import { capture, inspectBundle, safeFile } from './replay/bundle.ts';
import { runReplay } from './replay/run.ts';
import { compareReplay } from './replay/compare.ts';
import { ReplayError, requireFact, sha } from './replay/types.ts';
export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  try {
    const [command, ...args] = argv;
    const allowed: Record<string, string[]> = { capture: ['home', 'session', 'circle-app', 'out', 'guard-context'], inspect: ['bundle', 'source-sha'], run: ['bundle', 'circle-app', 'out', 'timeout-ms', 'pace', 'speed', 'source-sha'], compare: ['bundle', 'circle-app', 'out', 'candidate-guard', 'guard-timeout-ms', 'timeout-ms', 'source-sha', 'survey', 'mirror-base', 'replace', 'candidate-entry', 'candidate-settings', 'candidate-skills', 'candidate-protocol', 'mcp-server', 'permission-mode', 'on-failure', 'decision-only', 'candidate-all-cases'] };
    requireFact(command in allowed, '子命令必须是 capture、inspect、run 或 compare');
    const values = new Map<string, string>();
    const flags = new Set(['survey', 'decision-only', 'candidate-all-cases']);
    const candidateGuards: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const key = args[i].slice(2);
      // The candidate may be several files or directories: that one option may repeat
      requireFact(args[i].startsWith('--') && allowed[command].includes(key) && (key === 'candidate-guard' || !values.has(key)) && (flags.has(key) || args[i + 1] !== undefined), '参数缺失、重复或不支持');
      if (key === 'candidate-guard')
        candidateGuards.push(args[++i]);
      else
        values.set(key, flags.has(key) ? 'true' : args[++i]);
    }
    const need = (key: string) => { const v = values.get(key); requireFact(v && v.length > 0, '缺少必要参数'); return v; };
    const number = (key: string, defaultValue: number) => { const raw = values.get(key); const n = raw === undefined ? defaultValue : Number(raw); requireFact(Number.isFinite(n) && n > 0, '运行限额和速度必须为正数'); return n; };
    if (command === 'capture') {
      const target = need('out');
      capture({ home: need('home'), session: need('session'), app: need('circle-app'), out: target, guardContext: values.get('guard-context') });
      const b = inspectBundle(target);
      out(JSON.stringify({ counts: b.counts, sha256: sha(safeFile(target, 'source.json')), missing: b.gaps.length }));
      return 0;
    }
    const bundle = need('bundle');
    if (values.has('source-sha'))
      requireFact(sha(safeFile(bundle, 'source.json')) === need('source-sha'), '回放包根摘要不符');
    const b = inspectBundle(bundle);
    if (command === 'inspect') {
      out(JSON.stringify({ counts: b.counts, sha256: sha(safeFile(bundle, 'source.json')), guardContext: Boolean(b.source.indexHashes['guard-contexts.json']), missing: b.gaps.map(g => ({ fact: g.fact, next: g.next, blocking: g.blocking ?? false })) }));
      return b.gaps.some(g => g.blocking) ? 2 : 0;
    }
    const common = { bundle, app: need('circle-app'), out: need('out'), timeoutMs: number('timeout-ms', 120000) };
    if (command === 'compare') {
      const protocol = values.get('candidate-protocol') ?? '1.17.0';
      requireFact(protocol === '1.17.0' || protocol === '1.18', '候选协议只能是 1.17.0 或 1.18');
      const onFailure = values.get('on-failure');
      requireFact(onFailure === undefined || onFailure === 'block' || onFailure === 'continue', '失败处理只能是 block 或 continue');
      const r = await compareReplay({ ...common, guard: candidateGuards.length ? candidateGuards : undefined, replace: values.get('replace'), candidateEntry: values.get('candidate-entry'), candidateSettings: values.get('candidate-settings'), candidateSkills: values.get('candidate-skills'), protocol, mcpServer: values.get('mcp-server'), permissionMode: values.get('permission-mode'), onFailure, decisionOnly: values.has('decision-only'), allCases: values.has('candidate-all-cases'), guardTimeoutMs: number('guard-timeout-ms', 10000), survey: values.has('survey'), mirrorBase: values.get('mirror-base') });
      out(JSON.stringify({ status: r.status, mode: r.mode, counts: { compared: r.compared, attempted: r.attempted, matched: r.matched, mismatched: r.mismatched, unknown: r.unknown }, sha256: sha(safeFile(common.out, 'report.json')) }));
      return r.exit;
    }
    const pace = values.get('pace') ?? 'fast';
    requireFact(pace === 'fast' || pace === 'recorded', 'pace 必须是 fast 或 recorded');
    const r = await runReplay({ ...common, pace, speed: number('speed', 1) });
    out(JSON.stringify({ status: r.status, counts: r.actual, sha256: sha(safeFile(common.out, 'report.json')), missing: r.gaps?.length ?? 0 }));
    return r.exit;
  }
  catch (error) {
    const e = error instanceof ReplayError ? error : new ReplayError('无法读取或运行指定回放材料', 1);
    out(JSON.stringify({ fact: e.message, next: e.exit === 2 ? '补齐对应版本与边界证据后重试' : '核对参数、材料摘要与输出目录后重试' }));
    return e.exit;
  }
}
if (import.meta.main)
  process.exitCode = await main(process.argv.slice(2));
