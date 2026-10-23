// Stage one: a deterministic expansion/AST adapter. No knowledge registration, signatures, roots, network or storage writes.
import type { AstNode } from './vendor/core.mjs';
import { document, conditionValue, engineSession } from './engine.ts';
import { AdocFailure, canonical, ENGINE, fail, initialReport, LIMITS, POLICY, sha256, sourceLines, validate } from './input.ts';
import { expandIncludes } from './includes.ts';
import { verifyOrigin } from './origins.ts';
import type { AdocResult, Block, Composition, Limits, MappedLine, Section, SourceRange } from './types.ts';

function sourceRanges(rows: MappedLine[]): SourceRange[] {
  const out: SourceRange[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last?.file === row.file && last.to + 1 === row.line) { last.to++; last.lines++; }
    else out.push({ file: row.file, from: row.line, to: row.line, lines: 1 });
  }
  return out;
}

/** The contexts whose own content is the blocks the engine gives for their children. */
const LISTS = new Set(['ulist', 'olist', 'dlist']);
const IMAGE_LINE = /^image::{1,2}/;
/** The equals-sign marker of a heading line, which the engine's own title never carries. */
const HEADING_MARKER = /^={1,6}[ \t]+/;

/**
 * The text of a node to verify against the source lines: a heading's title (the engine keeps no source text for it), an
 * image's own source line (the engine keeps only its attributes), otherwise what the engine keeps as the node's source
 * or, for the contexts that have none (a list item), its converted text.
 */
function rawOf(node: AstNode, lines: MappedLine[]): string {
  if (node.context === 'section' || node.context === 'floating_title') return node.title ?? '';
  if (node.context === 'image') {
    const at = node.sourceLocation?.lineno;
    const line = at !== undefined && at >= 1 && at <= lines.length ? lines[at - 1] : undefined;
    return line !== undefined && IMAGE_LINE.test(line.text) ? line.text : '';
  }
  return node.getSource?.() ?? node.text ?? '';
}

/**
 * The engine's own inline output of a block whose source text it keeps (a paragraph), so the mapping can read the
 * author's markup as the engine converts it instead of re-implementing AsciiDoc inline semantics. The contexts that
 * already hand over converted text (a list item, a table cell) and the ones that are verbatim (a listing) are not
 * converted again, and a container is never asked: its content would be rendered a second time.
 */
async function inlineOutput(node: AstNode): Promise<string> {
  if (node.context !== 'paragraph' || typeof node.getContent !== 'function') return '';
  const value = await node.getContent();
  return typeof value === 'string' ? value : '';
}

/** Whether a node carries text of its own, which a reader would lose when the block is not placed. */
function hasOwnText(node: AstNode, raw: string): boolean {
  return raw !== '' || node.context === 'image';
}

async function runAdoc(rawInput: unknown, overrides: Partial<Limits> = {}): Promise<AdocResult> {
  try {
    for (const [key, value] of Object.entries(overrides)) if (!Object.hasOwn(LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key as keyof Limits]) fail('invalid_budget', '测试预算只能收紧，不能提高生产策略上限');
    const limits = { ...LIMITS, ...overrides };
    const input = validate(rawInput, limits);
    const report = initialReport(input);
    const originals = new Map(Object.entries(input.files).map(([file, value]) => [file, sourceLines(file, value.text).map((row) => row.text)]));
    const noteUnverified = (note: typeof report.unverified[number]): void => { report.unverified_count++; if (report.unverified.length < 100) report.unverified.push(note); else report.unverified_examples_truncated = true; };
    const noteDisambiguated = (note: typeof report.disambiguated[number]): void => { report.disambiguated_count++; if (report.disambiguated.length < 100) report.disambiguated.push(note); else report.disambiguated_examples_truncated = true; };
    const expanded = await expandIncludes(input, limits);
    const text = expanded.lines.map((row) => row.text).join('\n');
    report.unused_files = Object.keys(input.files).filter((file) => !expanded.used.has(file));
    for (const row of expanded.lines) if (/^={7,}\s+/.test(row.text)) report.invalid_headings.push({ file: row.file, line: row.line, text: row.text });
    const { doc, logger } = await document(text, input.main, input.attributes ?? {}, false);
    const reader = doc.getReader(), processLine = reader.processLine.bind(reader);
    const branchAt = new Map(expanded.branches.map((branch) => [branch.start, branch]));
    reader.processLine = async (line: string) => {
      const branch = branchAt.get(reader.cursor.lineno - 1);
      if (branch && branch.retained === undefined) {
        const parent = branch.parent === null ? null : expanded.branches[branch.parent - 1];
        branch.retained = parent?.retained === false ? false : await conditionValue(branch.directive, input.main, { ...doc.getAttributes() });
      }
      return processLine(line);
    };
    await doc.parse();
    report.engine_messages = logger.messages.map(({ severity, text }) => ({ severity, text }));
    if (logger.messages.some((m) => m.severity === 'ERROR' || m.severity === 'FATAL' || /\bunterminated \S+ block\b/i.test(m.text))) fail('engine_parse', '引擎报告结构错误，整组没有产出：' + logger.messages.map((m) => m.text).join('；').slice(0, 1000));
    const excluded = new Set<number>(), controls = new Set<number>();
    for (const branch of expanded.branches) {
      if (branch.retained === undefined) fail('conditional_context', '条件指令所在上下文没有被引擎求值，不能猜测分支', expanded.lines[branch.start].file, expanded.lines[branch.start].line);
      controls.add(branch.start); if (!branch.inline) controls.add(branch.end);
      const removed = branch.retained ? [] : branch.inline ? [expanded.lines[branch.start]] : expanded.lines.slice(branch.start + 1, branch.end);
      if (!branch.retained) for (let i = branch.start; i <= branch.end; i++) excluded.add(i);
      const row = expanded.lines[branch.start];
      report.conditions.push({ id: branch.id, directive: branch.directive, file: row.file, line: row.line, retained: branch.retained, parent: branch.parent, removed: sourceRanges(removed), removed_lines: removed.length });
    }
    const visible = new Set(expanded.lines.map((_, i) => i).filter((i) => !excluded.has(i) && (!controls.has(i) || branchAt.get(i)?.inline === true)));
    const blocks: Block[] = [];
    const paths = new Map<AstNode, Section[]>();
    const indexOf = new Map<AstNode, number>();
    const inExample = new Map<AstNode, boolean>();
    const nodes = doc.findBy();
    if (nodes.length > limits.blocks) fail('block_budget', '结构节点数量超过限制');
    for (const node of nodes) {
      if (node.context === 'document' || node.context === 'table_cell') continue;
      doc.playbackAttributes(node.attributes);
      const parentPath = node.parent ? paths.get(node.parent) ?? [] : [];
      const title = typeof node.title === 'string' ? doc.subAttributes(node.title) : null;
      const level = typeof node.level === 'number' ? node.level : parentPath.at(-1)?.level ?? 0;
      const path = node.context === 'section' ? [...parentPath, { level, title: title ?? '', id: node.getId() ?? null, at: blocks.length }] : parentPath;
      paths.set(node, path);
      const at = blocks.length;
      const raw = rawOf(node, expanded.lines);
      const verify = { originals, expand: (text: string): string => doc.subAttributes(text) };
      const verified = verifyOrigin(raw, node.context, node.sourceLocation?.lineno, expanded.lines, visible, input, verify);
      // An example is what the author declared: the `====` block, or a block whose role or style says example. Its own
      // children inherit it, so a signature-shaped paragraph inside an example stays reference only.
      const example = node.context === 'example' || node.getRole() === 'example' || node.style === 'example' || (node.parent != null && inExample.get(node.parent) === true);
      inExample.set(node, example);
      const listAt = node.context === 'list_item' && node.parent !== null && node.parent !== undefined && LISTS.has(node.parent.context) ? indexOf.get(node.parent) ?? null : null;
      const heading = (node.context === 'section' || node.context === 'floating_title') && verified.origins.length === 1
        ? doc.subAttributes(verified.origins[0]!.verbatim.replace(HEADING_MARKER, ''))
        : null;
      const block: Block = {
        kind: node.context, level, title, id: node.getId() ?? null, role: node.getRole() ?? null, path, raw, heading,
        expanded: node.subAttributes(raw), converted: await inlineOutput(node),
        origin: verified.origins.length === 1 ? verified.origins[0] : null, origins: verified.origins,
        reportedLine: node.sourceLocation?.lineno ?? null, unverifiedReason: verified.origins.length > 0 ? '' : verified.reason, listAt, example,
      };
      // A container with no text of its own has nothing to verify: its content is carried by the blocks the engine gives
      // for its children, each verified on its own. Reporting one as unverified would name a gap that is not there.
      if (!verified.origins.length && hasOwnText(node, raw)) noteUnverified({ block: at, kind: node.context, reported_line: node.sourceLocation?.lineno ?? null, reason: verified.reason, next_action: '已自动尝试 sourcemap 邻近行逐字回读（含结构标记、属性展开和排版替换的归一比较）；仍不能唯一定位时不生成引用，交下一阶段定位器修复后重跑' });
      else if (verified.flat !== null && verified.flat !== node.sourceLocation?.lineno) report.remapped.push({ block: at, reported_line: node.sourceLocation!.lineno, verified_line: verified.flat });
      if (verified.chosenAmong > 1) noteDisambiguated({ block: at, kind: node.context, reported_line: node.sourceLocation?.lineno ?? null, candidates: verified.chosenAmong });
      if (node.rows) {
        block.rows = {};
        for (const part of ['head', 'body', 'foot'] as const) block.rows[part] = node.rows[part].map((row) => row.map((cell) => {
          const raw = cell.text ?? '';
          const source = verifyOrigin(raw, 'table_cell', cell.sourceLocation?.lineno, expanded.lines, visible, input, verify);
          if (!source.origins.length) noteUnverified({ block: at, kind: 'table_cell', reported_line: cell.sourceLocation?.lineno ?? null, reason: source.reason, next_action: '已自动回读候选行但不能逐字唯一核对；本单元格不生成引用，修复定位器后重跑' });
          else if (source.chosenAmong > 1) noteDisambiguated({ block: at, kind: 'table_cell', reported_line: cell.sourceLocation?.lineno ?? null, candidates: source.chosenAmong });
          return { raw, expanded: cell.subAttributes(raw), origins: source.origins, reportedLine: cell.sourceLocation?.lineno ?? null };
        }));
      }
      indexOf.set(node, at);
      blocks.push(block);
    }
    report.engine_messages = logger.messages.map(({ severity, text }) => ({ severity, text }));
    if (logger.messages.some((m) => m.severity === 'ERROR' || m.severity === 'FATAL' || /\bunterminated \S+ block\b/i.test(m.text))) fail('engine_parse', '引擎报告结构错误，整组没有产出：' + logger.messages.map((m) => m.text).join('；').slice(0, 1000));
    const identity = { schema: 'apv-adoc-composition@1' as const, main: input.main, revision: input.revision, files: Object.entries(input.files).map(([file, value]) => ({ file, sha256: value.sha256 })), attributes: input.attributes ?? {}, engine: ENGINE, policy: POLICY, limits };
    const composition: Composition = { ...identity, sha256: sha256(canonical(identity)) };
    return { ok: true, composition, model: { schema: 'apv-adoc-expanded@1', expanded_text: text, line_map: expanded.lines.map(({ file, line }) => ({ file, line })), blocks }, report };
  } catch (error) {
    if (error instanceof AdocFailure) return { ok: false, error: { code: `apv.adoc.${error.code}`, message: error.message, next_action: '补齐或修正指出的原始事实，按同一修订号重新取得整组文件后重跑；失败结果不能替换旧知识根', ...(error.file ? { file: error.file } : {}), ...(error.line ? { line: error.line } : {}) } };
    return { ok: false, error: { code: 'apv.adoc.engine_error', message: '引擎无法完成整组展开，未返回部分模型', next_action: '检查输入语法和引擎沙箱错误，修复后按同一修订号重跑；不得应用部分结果' } };
  }
}
export async function compileAdoc(rawInput: unknown, overrides: Partial<Limits> = {}): Promise<AdocResult> {
  return engineSession(() => runAdoc(rawInput, overrides));
}
export default compileAdoc;
