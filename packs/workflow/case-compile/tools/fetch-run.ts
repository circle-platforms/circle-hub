// Decision 104: the inputs of tools/generate-workbook.ts for one run, fetched from the Hub with the user's own token instead of an
// administrator export: run.json, result.json and submission.json (the run, its latest accepted result and that result's
// submission as stored) and the run's bound contract.json, profile.json and inventory.json as exact bytes, each checked against
// the digest the run bound. The token is read from standard input only, never from the arguments or the environment. The
// command is the one form the skills home of scripts/real/circle-home.ts admits: the installed script by its full path and a
// quoted here-document whose only line is Circle's secret placeholder.
//   node <skill directory>/tools/fetch-run.ts --hub %HUB_URL% --run <run id> --out <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCallError, isRecord, failCall } from '../functions/text.ts';
import { argumentsOf, hubOrigin, RUN_ID, sha256, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { getRetrying, downloadRetryControl, readTokenFromStdin, requireBearerToken, type RetryControl } from '../functions/hub-retry.ts';

import { assertEmptySourceOutput, sourceMaterialNames, type SourceMaterial } from '../functions/source-materials.ts';

const SLOTS = ['contract', 'profile', 'inventory'] as const;
export interface RunInputs { run: Record<string, unknown>; result: Record<string, unknown>; submission: Record<string, unknown>; originals: Record<typeof SLOTS[number], Uint8Array>; run_reference?: string; accepted_result_reference?: string | null; materials?: SourceMaterial[] }
/** The run, its latest accepted result and submission, and the run's bound contract, profile and inventory, each checked. */
export async function fetchRunInputs(origin: string, bearer: string, run: string, retry?: RetryControl): Promise<RunInputs> {
  const raw = await getRetrying(`${origin}/run-export/${run}`, bearer, retry);
  let exported: unknown;
  try { exported = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { failCall('invalid_parameters', 'Hub 返回的原始用例和自动化用例无法读取', '重新获取完整 UTF-8 JSON 导出并核对协议后重试'); }
  if (!isRecord(exported) || exported.schema !== 'run-export@1' || !isRecord(exported.run) || !isRecord(exported.result) || !isRecord(exported.submission)) failCall('invalid_parameters', 'Hub 返回的原始用例和自动化用例不完整', '重新获取完整 run-export@1 导出并核对所需字段后重试');
  if (exported.run.run !== run || exported.result.run !== run || exported.submission.run !== run) failCall('invalid_parameters', 'Hub 返回的原始用例、自动化用例或核对结果不属于本次脚本编写，文件尚未保存', '核对指定运行与导出身份后重新下载');
  const sources = Array.isArray(exported.run.sources) ? exported.run.sources : [];
  const bindings = sources.filter(isRecord);
  const names = sourceMaterialNames(bindings);
  const originals = {} as RunInputs['originals'];
  const materials: SourceMaterial[] = [];
  for (const slot of SLOTS) {
    const bound = sources.filter((value) => isRecord(value) && value.slot === slot);
    const match = bound.length === 1 && isRecord(bound[0]) ? /^src:([0-9a-f]{64})$/.exec(String(bound[0].reference)) : null;
    if (!match) failCall('invalid_parameters', `来源槽 ${slot} 没有唯一绑定原件`, '核对当前运行的来源绑定，补齐该槽唯一的 src 引用后重试');
    const bytes = await getRetrying(`${origin}/run-export/${run}/sources/${match[1]}`, bearer, retry);
    if (sha256(bytes) !== match[1]) failCall('invalid_parameters', `来源槽 ${slot} 的字节与脚本编写时的原件不一致，文件尚未保存`, '恢复与运行绑定摘要一致的原件后重新下载');
    originals[slot] = bytes;
    const source = bound[0] as Record<string, unknown>;
    materials.push({ slot, role: typeof source.role === 'string' ? source.role : null, reference: String(source.reference), label: typeof source.label === 'string' ? source.label : null, media_type: typeof source.media_type === 'string' ? source.media_type : null, file: names[bindings.indexOf(source)], sha256: match[1] });
  }
  const run_reference = typeof exported.run_reference === 'string' && exported.run_reference ? exported.run_reference : undefined;
  const accepted_result_reference = typeof exported.accepted_result_reference === 'string' && exported.accepted_result_reference ? exported.accepted_result_reference : exported.accepted_result_reference === null ? null : undefined;
  return { materials, run: exported.run, result: exported.result, submission: exported.submission, originals, ...(run_reference !== undefined ? { run_reference } : {}), ...(accepted_result_reference !== undefined ? { accepted_result_reference } : {}) };
}
export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, retry?: RetryControl): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'out']);
    if (!RUN_ID.test(args.run)) failCall('invalid_parameters', '--run 不是声明格式的运行编号', '请使用本次用例重组或脚本编写的编号后重试');
    const origin = hubOrigin(args.hub);
    await assertEmptySourceOutput(args.out);
    const bearer = await requireBearerToken(readToken);
    // Every original is fetched and checked before anything is written, and a failed write removes what this call wrote, so
    // a failure never leaves part of the inputs behind.
    const fetched = await fetchRunInputs(origin, bearer, args.run, downloadRetryControl(args.out, retry));
    const hasRefs = fetched.run_reference !== undefined || fetched.accepted_result_reference !== undefined;
    const refDoc = hasRefs ? { schema: 'run-references@1', run: args.run, ...(fetched.run_reference !== undefined ? { run_reference: fetched.run_reference } : {}), ...(fetched.accepted_result_reference !== undefined ? { accepted_result_reference: fetched.accepted_result_reference } : {}) } : null;
    const outputs: Array<{ name: string; bytes: Uint8Array }> = [
      { name: 'run.json', bytes: Buffer.from(JSON.stringify(fetched.run)) },
      { name: 'result.json', bytes: Buffer.from(JSON.stringify(fetched.result)) },
      { name: 'submission.json', bytes: Buffer.from(JSON.stringify(fetched.submission)) },
      ...new Map((fetched.materials ?? []).map(material => [material.file!, { name: material.file!, bytes: fetched.originals[material.slot as typeof SLOTS[number]] }])).values(),
      { name: 'sources.json', bytes: Buffer.from(JSON.stringify(fetched.materials, null, 2) + '\n') },
      ...(refDoc ? [{ name: 'references.json', bytes: Buffer.from(JSON.stringify(refDoc, null, 2) + '\n') }] : []),
    ];
    await mkdir(args.out, { recursive: true, mode: 0o700 });

    const taken: string[] = [];
    for (const { name } of outputs) if (await lstat(join(args.out, name)).then(() => true, () => false)) taken.push(name);
    if (taken.length) failCall('occupied', '输出目录在下载期间出现了已有文件', '另选新的空目录重新下载，不覆盖已有资料', { path: args.out, legal_form: '--out <新的空目录>' });
    await mkdir(join(args.out, 'sources'), { mode: 0o700 });
    const files: Record<string, string> = {}; const written: string[] = [];
    try {
      for (const { name, bytes } of outputs) { const path = join(args.out, name); await writeNew(path, bytes); written.push(path); files[name] = sha256(bytes); }
    } catch (error) { await Promise.all(written.map((path) => rm(path, { force: true }))); throw error; }
    process.stdout.write(JSON.stringify({ run: args.run, ...(fetched.run_reference !== undefined ? { run_reference: fetched.run_reference } : {}), ...(fetched.accepted_result_reference !== undefined ? { accepted_result_reference: fetched.accepted_result_reference } : {}), files }) + '\n'); return 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
