// The adoc producer's step between K1's placement and the Hub's fragment contract. K1 copies a block's selector verbatim
// into every fragment it makes and stamps its own parser key on it (markdown@1), so the mapped model hands K1 a citation
// key of its own (`cite/<block>`, k1-model.ts) and this module turns every fragment back into the shape the Hub
// verifies: the chapter file's digest in `source`, `text@1` as the parser, the plain `l/<a>-<b>` line selector of the
// verified range and the producer's own slot. K1's placement code is not changed by it. A byte range inside a mapped
// table's text is only how K1 names a row: the fragment of a row is that row's own source line, with no range. A
// fragment this module cannot resolve refuses the whole group instead of going out as a reference to nothing.
import type { FragmentRef, ProducedEntry, Unplaced } from '../../../../../contracts/src/product.ts';
import { produceManualEntries } from '../manual.ts';
import type { CommandCatalog } from '../cases-commands.ts';
import { asStrings, isRecord } from '../util.ts';
import { citesExample, citationFor, type Mapped } from './k1-model.ts';

/** The parser of every fragment an adoc production cites: the chapter files as numbered lines. */
export const ADOC_PARSER = 'text@1';

/** The schema of the transitional manual command catalog (K1 item 4), which an adoc line no longer reads. */
export const CATALOG_SCHEMA = 'ist.manual-command-catalog';

/** One manual slot as the Hub hands it to a producer: the parser of the stored source and its parsed model. */
export interface ManualSlot {
  parser?: unknown;
  model?: unknown;
}

/**
 * Whether a manual slot of a line that has an adoc source still carries the transitional catalog JSON. This is where
 * that is known — the adoc producer sees the source it was given — so the decision is made here and not inside K1's
 * placement code, which reads a catalog whenever it is handed one.
 */
export function catalogOnAdocLine(slot: ManualSlot | null | undefined): boolean {
  if (slot === null || slot === undefined || slot.parser !== 'json@1') return false;
  return isRecord(slot.model) && slot.model.schema === CATALOG_SCHEMA;
}

/**
 * The refusal for that slot (task item 6: the transitional reading is off for a line with an adoc source). It is a typed
 * failure of the production, never an empty `{entries: [], warnings: […]}`: `ProducerOutput` has no failure channel, so
 * an empty output would be stored as a production that read this line's manual and found nothing in it, and the old
 * root would look as if it had been confirmed by a successful run.
 */
export function catalogRefusal(family?: string): { code: string; message: string; next_action: string } {
  return {
    code: 'apv.adoc.catalog_reading_off',
    message: `${family === undefined ? '这一版本线' : `名称族 ${family}`}的手册槽给的是 catalog.json（${CATALOG_SCHEMA}），而这一线有 adoc 源：catalog.json 的过渡读法对有 adoc 源的版本线已停用，这一组没有读它，也没有产出`,
    next_action:
      '把这条线的手册源换成 adoc 文件表（主文件加目录里的各章，同一 SVN 修订号，属性集按名称族给），或让管理员撤掉这条线的 catalog.json 过渡源，然后重新同步；在换源之前这条线不产出，旧知识根不动',
  };
}

export interface AdocEntryOptions {
  /** The manual name of this name family; K1 composes `/manual/<name>/<章节路径>` from it. */
  name: string;
  /** The producer's input slot. A fragment carries it whenever the producer has more than one slot or a list slot. */
  slot?: string;
  /** The command heads of the build, when the build's tree is readable (K1's anchor check). */
  heads?: readonly string[] | null;
  /** The build's command catalog, for the placement check and the drift candidates. */
  catalog?: CommandCatalog | null;
}

export type Produced =
  | { ok: true; entries: ProducedEntry[]; unplaced: Unplaced[]; warnings: string[] }
  | { ok: false; error: { code: string; message: string; next_action: string } };

/**
 * Places one family's mapped model with K1's own code and rewrites every fragment into the Hub's shape. Either every
 * fragment cites a verified line of a chapter file of this group, or the group produces nothing.
 */
export function produceAdocEntries(mapped: Mapped, options: AdocEntryOptions): Produced {
  const placed = produceManualEntries(mapped.model, options.heads ?? null, {
    name: options.name,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  const unresolved: string[] = [];
  const fragmentOf = (fragment: { selector: string; range?: [number, number] }, where: string): FragmentRef | null => {
    const cite = citationFor(mapped.model, fragment.selector, fragment.range);
    if (cite === null || cite.sha256 === '') {
      unresolved.push(`${where} 的片段 ${fragment.selector}${fragment.range === undefined ? '' : ` 范围 [${fragment.range[0]}, ${fragment.range[1]})`} 没有已核对的原文行`);
      return null;
    }
    return {
      ...(options.slot === undefined ? {} : { slot: options.slot }),
      source: cite.sha256,
      parser: ADOC_PARSER,
      selector: cite.selector,
    };
  };
  const entries: ProducedEntry[] = [];
  placed.entries.forEach((entry, index) => {
    const fragments: FragmentRef[] = [];
    for (const fragment of entry.fragments) {
      const rewritten = fragmentOf(fragment, `第 ${index + 1} 条（${entry.kind}）`);
      if (rewritten === null) return;
      fragments.push(rewritten);
    }
    // An example is reference only and takes no part in judgment (task item 6). K1 places its text like any other block
    // — under the command before it, with that command's words in `data` — so the mark rides on the entry: a reader, a
    // drift count or a review can tell example content from what the manual states.
    const reference = entry.fragments.length > 0 && entry.fragments.every((fragment) => citesExample(mapped.model, fragment.selector));
    entries.push(reference ? { ...entry, fragments, data: { ...entry.data, reference_only: true } } : { ...entry, fragments });
  });
  const unplaced: Unplaced[] = [];
  placed.unplaced.forEach((span, index) => {
    const fragment = fragmentOf(span.fragment, `第 ${index + 1} 个未归位片段`);
    if (fragment !== null) unplaced.push({ ...span, fragment });
  });
  if (unresolved.length > 0) {
    return {
      ok: false,
      error: {
        code: 'apv.adoc.fragment_not_cited',
        message: `有 ${unresolved.length} 个片段翻不成 text@1 引用，整组没有产出：${unresolved.slice(0, 5).join('；')}${unresolved.length > 5 ? ' 等' : ''}`,
        next_action:
          '这些片段的选择器不是本映射发出的引用键，或者它指的块、表格行没有已核对的原文行；核对映射（尤其表格行的引用）后按同一修订号重跑。失败结果不能替换旧知识根。',
      },
    };
  }
  // An example takes no part in judgment (task item 6), and K1's own checks run over the model it is given, so the
  // production's report lines — its drift candidates included — are read from a second run over the model without the
  // example content: a literal only an example carries is no drift candidate of the manual. The entries still carry the
  // example content, marked; only the report is computed as if the examples were not read for judgment. K1's placement of
  // every other block is the same in both runs (an example block is no anchor and ends no command), and K1's files are
  // not changed by it.
  const judgment = produceManualEntries({ ...mapped.model, blocks: mapped.model.blocks.filter((block) => !block.example) }, options.heads ?? null, {
    name: options.name,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  const warnings = [...mapped.warnings, ...judgment.warnings];
  const reference = entries.filter((entry) => entry.data.reference_only === true && asStrings(entry.data.command_literals).length > 0);
  if (reference.length > 0) {
    warnings.push(
      `有 ${reference.length} 条标为参考（data.reference_only）的条目带命令字面，共 ${new Set(reference.flatMap((entry) => asStrings(entry.data.command_literals))).size} 个。` +
        '示例不参与判定：漂移候选按不含示例内容的那一遍核对给出，这些字面不在其中。读时视图、评审与回归核对仍要按 data.reference_only 分流参考条目；本包不改 K1，也不代替消费端过滤。',
    );
  }
  return { ok: true, entries, unplaced, warnings };
}
