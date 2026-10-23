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
import { citationFor, type Mapped } from './k1-model.ts';

/** The parser of every fragment an adoc production cites: the chapter files as numbered lines. */
export const ADOC_PARSER = 'text@1';

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
    entries.push({ ...entry, fragments });
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
  return { ok: true, entries, unplaced, warnings: [...mapped.warnings, ...placed.warnings] };
}
