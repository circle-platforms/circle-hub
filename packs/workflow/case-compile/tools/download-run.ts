// The whole run on local disk before anything is written for it (decision 160, step 1): run.json, one file per frozen item and
// the original bytes of every bound source, each checked against its digest, so the model reads them with its own file tools
// instead of one Hub call per item. It reads the run alone, so it works right after start_run; it decides nothing. When the
// run brought its knowledge root and its items carry recomposition records, each case also gets its authoring brief
// (`briefs/<index>.md`, tools/authoring-brief.ts): the tree entries the record names, so a writer reads one file first.
//   node <skill directory>/tools/download-run.ts --hub %HUB_URL% --run <run id> --out <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, hubOrigin, RUN_ID, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { downloadRunRetrying, getRetrying, readTokenFromStdin, requireBearerToken, type RetryControl } from '../functions/hub-retry.ts';
import { writeBriefs } from './authoring-brief.ts';
import { formatCallError, isRecord } from '../functions/text.ts';

async function saveRunReference(origin: string, bearer: string, run: string, out: string, retry?: RetryControl): Promise<string | undefined> {
  const exported: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry)));
  if (!isRecord(exported) || typeof exported.run_reference !== 'string' || !exported.run_reference) return undefined;
  await writeNew(join(out, 'references.json'), Buffer.from(JSON.stringify({ schema: 'run-references@1', run, run_reference: exported.run_reference }, null, 2) + '\n'));
  return exported.run_reference;
}

export async function main(argv: string[], readToken: () => Promise<string> = readTokenFromStdin, brief: (directory: string) => Promise<{ briefs: number }> = writeBriefs, retry?: RetryControl): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'out']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 请使用本次用例重组或脚本编写的编号');
    const origin = hubOrigin(args.hub);
    const bearer = await requireBearerToken(readToken);
    const { files, ...report } = await downloadRunRetrying(origin, bearer, args.run, args.out, retry);
    const runReference = await saveRunReference(origin, bearer, args.run, args.out, retry);
    // The run is on disk by now: a brief that cannot be written is said, and is no reason to call the download failed.
    let briefs = 0, note: string | undefined;
    try { briefs = (await brief(args.out)).briefs; } catch (error) { note = `脚本编写所需的原始用例和手册未保存。原因${error instanceof Error ? error.message : '还没查清'}；其余原始资料已下载，请从原始资料继续脚本编写`; }
    process.stdout.write(JSON.stringify({ ...report, ...(runReference ? { run_reference: runReference } : {}), written: Object.keys(files).length + (runReference ? 1 : 0) + briefs, briefs, ...(note ? { briefs_note: note } : {}) }) + '\n'); return 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
