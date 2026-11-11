// The whole run on local disk before anything is written for it (decision 160, step 1): run.json, one file per frozen item and
// the original bytes of every bound source, each checked against its digest, so the model reads them with its own file tools
// instead of one Hub call per item. It reads the run alone, so it works right after start_run; it decides nothing. When the
// run brought its knowledge root and its items carry recomposition records, each case also gets its authoring brief
// (`briefs/<index>.md`, tools/authoring-brief.ts): the tree entries the record names, so a writer reads one file first.
//   node <skill directory>/tools/download-run.ts --hub %HUB_URL% --run <run id> --out <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsOf, bearerFrom, downloadRun, hubOrigin, RUN_ID, tokenFromStdin } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { writeBriefs } from './authoring-brief.ts';

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin, brief: (directory: string) => Promise<{ briefs: number }> = writeBriefs): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'out']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 请使用本次用例重组或脚本编写的编号');
    const origin = hubOrigin(args.hub);
    const { files, ...report } = await downloadRun(origin, await bearerFrom(readToken), args.run, args.out);
    // The run is on disk by now: a brief that cannot be written is said, and is no reason to call the download failed.
    let briefs = 0, note: string | undefined;
    try { briefs = (await brief(args.out)).briefs; } catch (error) { note = `脚本编写所需的原始用例和手册未保存。原因${error instanceof Error ? error.message : '还没查清'}；其余原始资料已下载，请从原始资料继续脚本编写`; }
    process.stdout.write(JSON.stringify({ ...report, written: Object.keys(files).length + briefs, briefs, ...(note ? { briefs_note: note } : {}) }) + '\n'); return 0;
  } catch (error) { process.stderr.write(`下载失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
