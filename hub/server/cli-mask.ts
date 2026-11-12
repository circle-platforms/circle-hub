// `circle-hub mask`: the masking dictionary (B02 R[11], decision 159, issue 194 step two). An administrator lists, sets,
// removes and tries rules. A rule's pattern is not a secret and is shown; what a pattern matched in a sample never is:
// `test` prints the replaced text only.
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { MASKING_DICTIONARY_SCHEMA, MASK_GROUP, MaskingRuleError, checkMaskingRule, compileMasking, maskPlaceholder, type MaskingRule } from '../../contracts/src/masking.ts';
import { VariableError, type Principal, type RecordsKit } from '../records/api.ts';
import { CliError, UsageError } from './errors.ts';

export interface MaskCommandSession {
  ctx: { io: { cwd: string } };
  admin(): Promise<Principal>;
  records(): Promise<RecordsKit>;
  out(line: string): void;
  err(line: string): void;
}

export const MASK_USAGE = 'mask list [--json] | set <规则名> --label <标签> (--pattern <正则> | --pattern-file <文件>) [--ignore-case] --reason <理由> | remove <规则名> --reason <理由> | test (<规则名> | --all | --pattern <正则> [--label <标签>] [--ignore-case]) --file <样本文件>';
const usage = (): never => { throw new UsageError(`用法：circle-hub ${MASK_USAGE}`); };
/** How much of a sample `test` reads and how many changed lines it prints. */
const MAX_SAMPLE_BYTES = 4 * 1024 * 1024, MAX_SHOWN_LINES = 40;

const line = (rule: MaskingRule): string => `${rule.name}  ${maskPlaceholder(rule.label)}  /${rule.pattern}/${rule.ignore_case ? 'i' : ''}${new RegExp(`\\(\\?<${MASK_GROUP}>`).test(rule.pattern) ? '（只替换 secret 分组）' : ''}`;

async function patternOf(session: MaskCommandSession, values: { pattern?: string; 'pattern-file'?: string }): Promise<string> {
  if ((values.pattern === undefined) === (values['pattern-file'] === undefined)) usage();
  if (values.pattern !== undefined) return values.pattern;
  // A pattern kept in a file: no shell quoting to get wrong. A single trailing line break is the file's, not the pattern's.
  return (await readFile(resolvePath(session.ctx.io.cwd, values['pattern-file']!), 'utf8')).replace(/\r?\n$/, '');
}

/** The dictionary's store; a records kit without one cannot have been opened by a running command. */
async function dictionary(session: MaskCommandSession): Promise<NonNullable<RecordsKit['masking']>> {
  const masking = (await session.records()).masking;
  if (masking === undefined) throw new CliError('这个 Hub 的记录存储没有遮盖字典');
  return masking;
}

function refuse(error: unknown): never {
  if (error instanceof MaskingRuleError || error instanceof VariableError) throw new CliError(error.message);
  throw error;
}

export async function maskCommand(session: MaskCommandSession, args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args;
  const parsed = (() => {
    try {
      return parseArgs({ args: [...rest], allowPositionals: true, strict: true, options: {
        json: { type: 'boolean' }, label: { type: 'string' }, pattern: { type: 'string' }, 'pattern-file': { type: 'string' }, 'ignore-case': { type: 'boolean' },
        reason: { type: 'string' }, file: { type: 'string' }, all: { type: 'boolean' },
      } });
    } catch { return usage(); }
  })();
  const { values, positionals } = parsed;
  if (verb === 'list') {
    if (positionals.length > 0) usage();
    const state = await (await dictionary(session)).list(await session.admin());
    if (values.json) { session.out(JSON.stringify({ rules: state.rules, dictionary: state.decision?.body.revoked ? null : state.decision?.body.bound ?? null, decided_at: state.decision?.body.decided_at ?? null })); return 0; }
    if (state.rules.length === 0) { session.out('遮盖字典里没有规则：业务系统的应答原样保存'); return 0; }
    session.out(`遮盖字典 ${state.rules.length} 条规则（读业务系统的文本应答时，命中的片段换成方括号里的文字后再保存）：`);
    for (const rule of state.rules) session.out(`  ${line(rule)}`);
    return 0;
  }
  if (verb === 'set') {
    if (positionals.length !== 1 || values.label === undefined || values.reason === undefined) usage();
    const rule = { name: positionals[0], label: values.label!, pattern: await patternOf(session, values), ignore_case: values['ignore-case'] === true };
    const state = await (await dictionary(session)).set(await session.admin(), rule, values.reason!).catch(refuse);
    session.out(`${state.created ? '已添加' : '已更新'}遮盖规则 ${line(state.rules.find((row) => row.name === rule.name)!)}`);
    session.out(`现在共 ${state.rules.length} 条规则；之后读到的业务系统应答按新规则替换，已经保存的内容不改写`);
    return 0;
  }
  if (verb === 'remove') {
    if (positionals.length !== 1 || values.reason === undefined) usage();
    const state = await (await dictionary(session)).remove(await session.admin(), positionals[0], values.reason!).catch(refuse);
    session.out(`已删除遮盖规则 ${positionals[0]}；现在共 ${state.rules.length} 条规则。已经按它替换过的内容不恢复`);
    return 0;
  }
  if (verb === 'test') {
    if (values.file === undefined) usage();
    const drafted = values.pattern !== undefined || values['pattern-file'] !== undefined;
    if ([drafted, values.all === true, positionals.length === 1].filter(Boolean).length !== 1 || positionals.length > 1) usage();
    let rules: MaskingRule[];
    if (drafted) {
      try { rules = [checkMaskingRule({ name: 'draft', label: values.label ?? '密码', pattern: await patternOf(session, values), ignore_case: values['ignore-case'] === true })]; } catch (error) { return refuse(error); }
    } else {
      const state = await (await dictionary(session)).list(await session.admin());
      rules = values.all ? state.rules : state.rules.filter((rule) => rule.name === positionals[0]);
      if (!values.all && rules.length === 0) throw new CliError(`没有名为 ${positionals[0].slice(0, 80)} 的规则；circle-hub mask list 看现有规则`);
    }
    const bytes = await readFile(resolvePath(session.ctx.io.cwd, values.file!));
    if (bytes.byteLength > MAX_SAMPLE_BYTES) throw new CliError(`样本 ${bytes.byteLength} 字节，超过 ${MAX_SAMPLE_BYTES} 字节；截一段有代表性的内容再试`);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new CliError('样本不是 UTF-8 文本；遮盖字典只处理文本'); }
    const started = performance.now();
    const masked = compileMasking({ schema: MASKING_DICTIONARY_SCHEMA, rules }).apply(text);
    const took = performance.now() - started;
    const total = masked.applied.reduce((sum, row) => sum + row.count, 0);
    session.out(`样本 ${bytes.byteLength} 字节，${rules.length} 条规则，替换 ${total} 处，用时 ${took < 1 ? '不到 1' : Math.round(took)} 毫秒`);
    for (const row of masked.applied) session.out(`  ${row.rule}：${row.count} 处`);
    if (total === 0) return 0;
    // Only lines that carry a placeholder, as they read after the replacement: the matched values are printed nowhere.
    const changed = masked.text.split(/\r?\n/).map((content, index) => ({ content, index })).filter((row) => rules.some((rule) => row.content.includes(maskPlaceholder(rule.label))));
    session.out(`替换后的行${changed.length > MAX_SHOWN_LINES ? `（前 ${MAX_SHOWN_LINES} 行，共 ${changed.length} 行）` : ''}：`);
    for (const row of changed.slice(0, MAX_SHOWN_LINES)) session.out(`  ${row.index + 1}: ${row.content.length > 300 ? `${row.content.slice(0, 300)}…` : row.content}`);
    return 0;
  }
  return usage();
}
