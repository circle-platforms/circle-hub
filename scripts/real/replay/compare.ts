import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { canonical, keyOf, ReplayError, requireFact, sha, type Bundle } from './types.ts';
import { inspectBundle, privateDirectory, safeFile, writePrivate } from './bundle.ts';
import { runReplay } from './run.ts';
export interface GuardContextInput {
  schema: 'circle-replay-guard-context@1';
  cases: {
    session: string;
    call: string;
    input: Record<string, unknown>;
    entry: string;
    replace?: string;
    files: Record<string, string>;
    baseline: {
      decision: 'allow' | 'deny' | 'ask' | 'none';
      reason: string;
    };
    provenance: 'scripted' | 'operator';
  }[];
}
export function validateGuardContext(value: GuardContextInput, b: Bundle): void {
  requireFact(value.schema === 'circle-replay-guard-context@1' && Array.isArray(value.cases), '守卫上下文格式无效');
  const seen = new Set<string>();
  for (const c of value.cases) {
    const key = keyOf(c.session, c.call);
    const p = b.pairs.get(key);
    requireFact(p && !seen.has(key), '守卫上下文缺少唯一来源调用');
    seen.add(key);
    requireFact(c.provenance === 'scripted' || c.provenance === 'operator', '守卫上下文缺少来源声明');
    requireFact(c.input.tool_name === p.call.name && canonical(c.input.tool_input) === canonical(p.call.args), '守卫上下文改变了模型工具参数');
    requireFact(c.files && typeof c.files === 'object' && typeof c.entry === 'string' && typeof c.files[c.entry] === 'string' && typeof c.files[c.replace ?? c.entry] === 'string', '守卫上下文入口或候选替换文件缺失');
    for (const [name, content] of Object.entries(c.files))
      requireFact(typeof content === 'string' && !isAbsolute(name) && name.split(/[\\/]/).every(x => x !== '' && x !== '.' && x !== '..'), '守卫文件路径或内容无效');
    requireFact(['allow', 'deny', 'ask', 'none'].includes(c.baseline?.decision) && typeof c.baseline.reason === 'string', '守卫基线决定无效');
    if (p.denied)
      requireFact(c.baseline.decision === 'deny' && c.baseline.reason === p.denied.reason, '守卫基线与拒绝记录不符');
  }
}
async function candidate(file: string, input: string, root: string, timeoutMs: number, evidence: string): Promise<{
  decision: string;
  reason: string;
  stdoutSha256: string;
  stderrSha256: string;
  exitCode: number | null;
}> {
  writePrivate(evidence, 'input.json', input);
  const preload = fileURLToPath(new URL('./guard-preload.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${dirname(preload)}`, '--import', preload, file], { cwd: join(root, 'work'), env: { CIRCLE_HOME: root, CIRCLE_NO_UPDATE_CHECK: '1', CIRCLE_NO_MODELS_REFRESH: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, failed: string | undefined;
    const stop = (fact: string) => { failed ??= fact; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('候选守卫达到注入限额'), timeoutMs);
    child.stdout.on('data', (data: Buffer) => {
      size += data.length; if (size > 1048576)
        stop('候选守卫输出超过上限');
      else
        stdout.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      size += data.length; if (size > 1048576)
        stop('候选守卫输出超过上限');
      else
        stderr.push(data);
    });
    child.once('error', () => { clearTimeout(timer); reject(new ReplayError('候选守卫无法启动', 2)); });
    child.stdin.on('error', () => { });
    child.stdin.end(input);
    child.once('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString();
      writePrivate(evidence, 'stdout.txt', out);
      writePrivate(evidence, 'stderr.txt', err);
      writePrivate(evidence, 'receipt.json', JSON.stringify({ exitCode: code, failure: failed ?? null, inputSha256: sha(input), stdoutSha256: sha(out), stderrSha256: sha(err) }));
      if (failed || err.includes('REPLAY_NETWORK_BLOCKED') || err.includes('ERR_ACCESS_DENIED')) {
        reject(new ReplayError(failed ?? '候选守卫尝试了不允许的网络、进程或文件操作', 2));
        return;
      }
      let value: any;
      try {
        value = JSON.parse(out);
      }
      catch {
        if (code === 2) {
          resolve({ decision: 'deny', reason: err.trim(), stdoutSha256: sha(out), stderrSha256: sha(err), exitCode: code });
          return;
        }
        reject(new ReplayError('候选守卫没有交付合法决定', 2));
        return;
      }
      if (code !== 0) {
        reject(new ReplayError('候选守卫执行失败', 2));
        return;
      }
      const specific = value.hookSpecificOutput;
      const decision = specific?.permissionDecision ?? value.decision ?? 'none';
      const reason = specific?.permissionDecisionReason ?? value.reason ?? '';
      if (!['allow', 'deny', 'ask', 'none'].includes(decision) || typeof reason !== 'string') {
        reject(new ReplayError('候选守卫决定结构无效', 2));
        return;
      }
      resolve({ decision, reason, stdoutSha256: sha(out), stderrSha256: sha(err), exitCode: code });
    });
  });
}
export async function compareReplay(options: {
  bundle: string;
  app: string;
  guard: string;
  out: string;
  timeoutMs?: number;
  guardTimeoutMs?: number;
}): Promise<{
  exit: number;
  status: string;
  compared: number;
  attempted: number;
  candidateSha256?: string;
  firstDifference?: unknown;
}> {
  const b = inspectBundle(options.bundle);
  const out = privateDirectory(options.out, [b.directory, b.source.home, ...b.source.workspaces, options.app]);
  const baseline = await runReplay({ bundle: options.bundle, app: options.app, out: join(out, 'baseline'), timeoutMs: options.timeoutMs });
  const report: {
    exit: number;
    status: string;
    compared: number;
    attempted: number;
    candidateSha256?: string;
    firstDifference?: unknown;
  } = { exit: baseline.exit, status: baseline.status, compared: 0, attempted: 0, firstDifference: baseline.firstDifference };
  if (baseline.exit === 0) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'circle-replay-guard-')));
    try {
      if (!b.source.indexHashes['guard-contexts.json'])
        throw new ReplayError('缺少历史守卫状态与明确的候选输入映射', 2);
      const candidateBytes = readFileSync(options.guard);
      report.candidateSha256 = sha(candidateBytes);
      writePrivate(out, 'candidate-source.bin', candidateBytes);
      const contexts = JSON.parse(safeFile(b.directory, 'guard-contexts.json').toString()) as GuardContextInput;
      validateGuardContext(contexts, b);
      const cases = new Map(contexts.cases.map(c => [keyOf(c.session, c.call), c]));
      const order = baseline.coverage.invocationOrder as {
        session: string;
        call: string;
      }[];
      for (const invocation of order) {
        const c = cases.get(keyOf(invocation.session, invocation.call));
        if (!c)
          throw new ReplayError('当前调用缺少历史守卫状态', 2, { session: invocation.session, call: invocation.call });
        const dir = join(root, String(report.compared));
        mkdirSync(dir, { mode: 0o700 });
        mkdirSync(join(dir, 'work'), { mode: 0o700 });
        for (const [name, content] of Object.entries(c.files)) {
          mkdirSync(dirname(join(dir, name)), { recursive: true, mode: 0o700 });
          writePrivate(dir, name, content);
        }
        const target = c.replace ?? c.entry;
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(dir, target), candidateBytes, { mode: 0o600 });
        const input = { ...c.input, cwd: join(dir, 'work') };
        const evidence = join(out, `guard-${report.attempted++}`);
        mkdirSync(evidence, { mode: 0o700 });
        const actual = await candidate(join(dir, c.entry), JSON.stringify(input), dir, options.guardTimeoutMs ?? 10000, evidence);
        report.compared++;
        if (actual.decision !== c.baseline.decision || actual.reason !== c.baseline.reason) {
          report.exit = 1;
          report.status = 'different';
          report.firstDifference = { ...invocation, expectedSha256: sha(canonical(c.baseline)), actualSha256: sha(canonical({ decision: actual.decision, reason: actual.reason })), inputSha256: sha(JSON.stringify(input)), ...actual, reasonSha256: sha(actual.reason) };
          delete (report.firstDifference as Record<string, unknown>).reason;
          break;
        }
      }
    }
    catch (error) {
      const e = error instanceof ReplayError ? error : new ReplayError('候选守卫比较异常', 1);
      report.exit = e.exit;
      report.status = e.exit === 2 ? 'unavailable' : 'different';
      report.firstDifference = { fact: e.message, ...e.detail };
    }
    finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  writePrivate(out, 'report.json', JSON.stringify(report, null, 2) + '\n');
  return report;
}
