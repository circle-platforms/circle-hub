// The producers of the product (product@1 producers, ProducerInput -> ProducerOutput). The Hub reads each source, parses it
// with the core parser for its media type and hands the model in by slot; the entries point back into it by parser and
// selector (and slot, for a producer with several inputs). Entry kinds are K02 R[3]'s: the command tree gives definitions,
// the manual definitions for signatures and behaviours for the text under a command, the fixed-bug list defects.
// - commandTree: slot tree (xml@1 of command_tree-<build>.xml) -> one definition per full command at /commands/<words>
// - manual: slots cli and app (markdown@1 of the CLI and application manuals of the build's line, both optional)
// - releaseNotes: slot notes (the fixed-bug list of the build: html@1 of the build site's page, or a markdown@1 release
//   note) -> defect entries, placed later by the typed-judgment model (path null), applicable to the build
import type { ProducerOutput } from '../../../../contracts/src/product.ts';
import { produceCommandEntries } from './command-tree.ts';
import { fixedBugEntries } from './fixed-bugs.ts';
import { produceManualEntries } from './manual.ts';
import { produceReleaseEntries } from './release-notes.ts';
import type { CommandTreeParams, FragmentRef, MarkdownModel, ProducedEntry, Unplaced, XmlModel } from './types.ts';
import { internalError, isRecord } from './util.ts';

type Slot = { parser?: unknown; model?: unknown } | null | undefined;

function slotOf(input: unknown, name: string): Slot {
  const slots = isRecord(input) && isRecord(input.slots) ? input.slots : {};
  const slot = slots[name];
  return isRecord(slot) ? (slot as Slot) : null;
}

function paramsOf(input: unknown): Record<string, unknown> {
  return isRecord(input) && isRecord(input.params) ? input.params : {};
}

function buildName(input: unknown): string | null {
  const build = isRecord(input) && isRecord(input.build) ? input.build : {};
  return typeof build.name === 'string' && build.name !== '' ? build.name : null;
}

const empty = (warning: string): ProducerOutput => ({ entries: [], warnings: [warning] });

/** Command tree: one definition entry per full command, its argument lists as overloads (catalog-entry@1 data). */
export function commandTree(input: unknown): ProducerOutput {
  try {
    const slot = slotOf(input, 'tree');
    if (slot === null || slot === undefined) return empty('没有命令树');
    if (slot.parser !== 'xml@1') return empty(`命令树不是 XML（解析器 ${String(slot.parser)}）`);
    const out = produceCommandEntries(slot.model as XmlModel, paramsOf(input) as CommandTreeParams);
    return { entries: out.entries as ProducedEntry[], warnings: out.warnings };
  } catch (error) {
    return empty(internalError(error));
  }
}

const withSlot = (fragment: FragmentRef, slot: string): FragmentRef & { slot: string } => ({ slot, ...fragment });

/** Manuals of the line: signature paragraphs are definitions, the text under a command behaviours, the rest unplaced. */
export function manual(input: unknown): ProducerOutput {
  const entries: ProducedEntry[] = [];
  const unplaced: Unplaced[] = [];
  const warnings: string[] = [];
  try {
    const heads = Array.isArray(paramsOf(input).heads) ? (paramsOf(input).heads as unknown[]).filter((h): h is string => typeof h === 'string') : null;
    for (const name of ['cli', 'app']) {
      const slot = slotOf(input, name);
      if (slot === null || slot === undefined) {
        warnings.push(`没有${name === 'cli' ? ' CLI ' : '应用'}手册`);
        continue;
      }
      if (slot.parser !== 'markdown@1') {
        warnings.push(`${name} 手册不是 Markdown（解析器 ${String(slot.parser)}），没有读`);
        continue;
      }
      const out = produceManualEntries(slot.model as MarkdownModel, heads);
      for (const entry of out.entries) entries.push({ ...entry, fragments: entry.fragments.map((f) => withSlot(f, name)) });
      for (const span of out.unplaced) unplaced.push({ ...span, fragment: withSlot(span.fragment, name) });
      warnings.push(...out.warnings.map((w) => `${name}：${w}`));
    }
    return { entries, unplaced, warnings };
  } catch (error) {
    return { entries, unplaced, warnings: [...warnings, internalError(error)] };
  }
}

/** Defects fixed in the build: the build site's fixed-bug list (HTML) or a release note (Markdown). */
export function releaseNotes(input: unknown): ProducerOutput {
  try {
    const slot = slotOf(input, 'notes');
    if (slot === null || slot === undefined) return empty('没有修复缺陷清单');
    const build = buildName(input);
    if (slot.parser === 'html@1') return fixedBugEntries(slot.model, build);
    if (slot.parser === 'markdown@1') {
      const out = produceReleaseEntries(slot.model as MarkdownModel);
      const entries = out.entries.map((entry) => (build !== null && out.build === null ? { ...entry, applicability: { builds: [build] } } : entry));
      return { entries, warnings: out.warnings };
    }
    return empty(`修复缺陷清单的格式读不了（解析器 ${String(slot.parser)}）`);
  } catch (error) {
    return empty(internalError(error));
  }
}
