// The whole run on local disk before anything is written for it (decision 160, step 1): run.json, one file per frozen item and
// the original bytes of every bound source, each checked against its digest, so the model reads them with its own file tools
// instead of one Hub call per item. It reads the run alone, so it works right after start_run; it decides nothing.
//   node <skill directory>/tools/download-run.ts --hub %HUB_URL% --run <run id> --out <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, bearerFrom, hubOrigin, RUN_ID, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { downloadRunRetrying, getRetrying, type RetryControl } from '../functions/hub-retry.ts';
import { formatCallError, isRecord } from '../functions/text.ts';

async function saveRunReference(origin: string, bearer: string, run: string, out: string, retry?: RetryControl): Promise<string | undefined> {
  const exported: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await getRetrying(`${origin}/run-export/${run}/run`, bearer, retry)));
  if (!isRecord(exported) || typeof exported.run_reference !== 'string' || !exported.run_reference) return undefined;
  await writeNew(join(out, 'references.json'), Buffer.from(JSON.stringify({ schema: 'run-references@1', run, run_reference: exported.run_reference }, null, 2) + '\n'));
  return exported.run_reference;
}

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin, retry?: RetryControl): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'out']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 请使用本次用例重组或脚本编写的编号');
    const origin = hubOrigin(args.hub);
    const bearer = await bearerFrom(readToken);
    const { files, ...report } = await downloadRunRetrying(origin, bearer, args.run, args.out, retry);
    const runReference = await saveRunReference(origin, bearer, args.run, args.out, retry);
    process.stdout.write(JSON.stringify({ ...report, ...(runReference ? { run_reference: runReference } : {}), written: Object.keys(files).length + (runReference ? 1 : 0) }) + '\n'); return 0;
  } catch (error) { process.stderr.write(formatCallError(error) + '\n'); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
