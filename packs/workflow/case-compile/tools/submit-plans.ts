// A whole mind map's plans do not fit in one model message: five cases took 27 KB of tool arguments and a model's output stops
// near 32k tokens. The model writes one file per case and this tool sends them as the one complete submission a run takes, so a
// repaired case is rewritten alone and several writers can each own their files. It decides nothing: every file reaches the Hub
// as written and all checks stay there. The token comes from standard input, as tools/fetch-run.ts reads it. One thing is done
// before sending: a literal of a set length written as a placeholder ({{domain:253}}, functions/length-literals.ts) is expanded
// and the expanded case is written back to its file, so the file is what the Hub receives and the model reads lengths, not counts.
//   node <skill directory>/tools/submit-plans.ts --hub %HUB_URL% --run <run id> --model <model> --plans <directory> <<'EOF'
//   %HUB_TOKEN%
//   EOF
import { realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeExpansions, expandValue } from '../functions/length-literals.ts';
import { argumentsOf, bearerFrom, hubOrigin, itemFiles, RUN_ID, submitResult, tokenFromStdin, writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';

export const planItems = itemFiles;

const SHOWN_CHARS = 12_000;

/** Expands the length placeholders of every case file in `directory`, rewriting only the files that had one; returns what each became. */
export async function expandPlanFiles(directory: string): Promise<string[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  const lines: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const text = await readFile(path, 'utf8');
    if (!text.includes('{{')) continue;
    let value: unknown;
    try { value = JSON.parse(text); } catch { continue; } // the reader below names the file that is not JSON
    let expanded: ReturnType<typeof expandValue>;
    try { expanded = expandValue(value); } catch (error) { throw new Error(`${name}：${error instanceof Error ? error.message : '长度占位无法展开'}`); }
    if (!expanded.expansions.length) continue;
    await writeFile(path, JSON.stringify(expanded.value, null, 2) + '\n'); // the case file itself, as the model wrote it
    lines.push(...describeExpansions(name, expanded.expansions));
  }
  return lines;
}

export async function main(argv: string[], readToken: () => Promise<string> = tokenFromStdin): Promise<number> {
  try {
    const args = argumentsOf(argv, ['hub', 'run', 'model', 'plans']);
    if (!RUN_ID.test(args.run)) throw new Error('--run 必须是运行编号');
    const origin = hubOrigin(args.hub);
    const expanded = await expandPlanFiles(args.plans);
    if (expanded.length) process.stdout.write(`长度占位已展开并写回文件：\n${expanded.join('\n')}\n`);
    const items = await planItems(args.plans);
    const bearer = await bearerFrom(readToken);
    const { text, failed } = await submitResult(origin, bearer, { run: args.run, model: args.model, items });
    const path = join(args.plans, `answer-${Date.now()}.txt`);
    await writeNew(path, Buffer.from(text));
    const clipped = text.length > SHOWN_CHARS;
    process.stdout.write(`${items.length} 个条目已提交\n${text.slice(0, SHOWN_CHARS)}\n${clipped ? `Hub 答复共 ${text.length} 字符，全文在 ${path}，用 read_file 分段读完\n` : `全文在 ${path}\n`}`);
    return failed ? 1 : 0;
  } catch (error) { process.stderr.write(`提交失败：${error instanceof Error ? error.message : '输入无效'}\n`); return 1; }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));
