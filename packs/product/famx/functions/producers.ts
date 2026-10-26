import {fixedBugEntries} from './fixed-bugs.ts';
import {labelOf} from './generated/vocabulary.ts';
// The producers of the product (product@1 producers, ProducerInput -> ProducerOutput). The Hub reads each source, parses it
// with the core parser for its media type and hands the model in by slot; the entries point back into it by parser and
// selector (and slot, for a producer with several inputs). Entry kinds are K02 R[3]'s: the command tree gives definitions,
// the manual definitions for signatures and behaviours for the text under a command, the fixed-bug list defects.
// - commandTree: slot tree (xml@1 of command_tree-<build>.xml) -> one definition per full command at /commands/<words>
// - manual: slots cli and app (markdown@1 of the CLI and application manuals of the build's line, both optional), plus
//   the tree slot (the build's command tree): it decides which signatures hang at existing /commands nodes and gives
//   the drift list of the author-marked literals the tree cannot resolve; the rest hangs at /manual/<slot>/<章节路径>
// - releaseNotes: slot notes (the fixed-bug list of the build: html@1 of the build site's page, or a markdown@1 release
//   note) -> defect entries with path null (code_only: they stay unplaced at the root; offering them to the bot's
//   verified placement proposals is an owner decision, K04 R[6]), applicable to the build
import type { ProducerOutput } from '../../../../contracts/src/product.ts';
import { commandCatalog, type CommandCatalog } from './cases-commands.ts';
import { produceCommandEntries, bindCommandSource } from './command-tree.ts';
import { ApplicabilitySourceError,produceManualEntries } from './manual.ts';
import { produceReleaseEntries,undeclaredReleaseEntry,STATUS_NEXT } from './release-notes.ts';
import type { CommandTreeParams, FragmentRef, MarkdownModel, ProducedEntry, Unplaced, XmlModel } from './types.ts';
import { internalError, isRecord } from './util.ts';

type Slot = { sha256?:unknown; parser?: unknown; model?: unknown } | null | undefined;

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
    // Group only source/schema attributes and generated states; warning text is never parsed.
    const groups=new Map<string,{diagnostic:NonNullable<typeof out.diagnostics>[number];count:number}>();
    for(const diagnostic of out.diagnostics??[]){
      const key=JSON.stringify([diagnostic.attribute,diagnostic.type_declaration_status,diagnostic.command_parse_status,diagnostic.syntax_valid]);
      const held=groups.get(key);if(held)held.count++;else groups.set(key,{diagnostic,count:1});
    }
    const summaries=[...groups.values()].map(({diagnostic:d,count})=>`${d.attribute}：${labelOf('type_declaration_status',d.type_declaration_status)}；${labelOf('command_parse_status',d.command_parse_status)}（${count} 处）；缺失事实：${d.missing}；下一步：${d.next_action}；由 ${d.audience} 在 ${d.due} 完成`);
    // The pack's own provenance never crosses the producer contract: producer-output@1 is strict, so `declarations`
    // stays inside the pack (it feeds bindCommandSource) and only the declared fields go out.
    const { declarations, ...produced } = out;
    return {...produced,entries:isRecord(slot)&&typeof slot.sha256==='string'?bindCommandSource(out.entries as ProducedEntry[],slot.sha256,declarations??{}):out.entries as ProducedEntry[],warnings:[...new Set([...summaries,...out.warnings])] };

  } catch (error) {
    return empty(internalError(error));
  }
}

const withSlot = (fragment: FragmentRef, slot: string): FragmentRef & { slot: string } => ({ slot, ...fragment });

/**
 * Manuals of the line: signature paragraphs are definitions (at /commands only when the build's command tree has the
 * command), the text under a command behaviours, every other block hangs at its section node under /manual/<slot>. The
 * `tree` slot (the build's command tree) decides existence and the drift list. Two modes: a direct call without a
 * catalog places by the literal, unchecked; a production with no tree slot or a non-xml@1 tree keeps every signature
 * at its section node, warns with the missing fact and the next action, and lists no drift.
 */
export function manual(input: unknown): ProducerOutput {
  const entries: ProducedEntry[] = [];
  const unplaced: Unplaced[] = [];
  const warnings: string[] = [];
  try {
    const params=paramsOf(input);
    const conditionOptions={known_builds:isRecord(input)&&Array.isArray(input.known_builds)?input.known_builds.filter((v):v is string=>typeof v==='string'):[],models:params.models as string[]|undefined,platforms:params.platforms as string[]|undefined,components:params.components as string[]|undefined,licenses:params.licenses as string[]|undefined,deployment_forms:params.deployment_forms as string[]|undefined};
    const heads = Array.isArray(paramsOf(input).heads) ? (paramsOf(input).heads as unknown[]).filter((h): h is string => typeof h === 'string') : null;
    // The command catalog of the build is built once, when a manual is actually read.
    let catalog: CommandCatalog | null | undefined;
    const catalogOf = (): CommandCatalog | null => {
      if (catalog !== undefined) return catalog;
      // Without a usable tree NO /commands path is created (research 2 rule 1): signatures stay at their section
      // nodes. The missing fact (which commands this build has) and the next action (supply an xml@1 tree) are named.
      const tree = slotOf(input, 'tree');
      if (tree === null || tree === undefined) {
        warnings.push('命令树不可用（没有 tree 槽）：签名留在章节节点，没有漂移候选清单；给本构建的命令树（xml@1）后重新生产');
        return null;
      }
      if (tree.parser !== 'xml@1') {
        warnings.push(`命令树不可用（解析器是 ${String(tree.parser)}，不是 xml@1）：签名留在章节节点，没有漂移候选清单；给本构建的命令树（xml@1）后重新生产`);
        return null;
      }
      const built = commandCatalog(tree.model as XmlModel);
      // The command-tree producer reports the catalog's own warnings; repeating them here only fills the capped
      // warning list ahead of the manual's drift warning (finding 20).
      catalog = built.catalog;
      return catalog;
    };
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
      // With an unusable tree the entries hang at their section nodes: no synthetic /commands path (research 2
      // rule 1), and the warning above names the missing fact and the next action.
      const built = catalogOf();
      const out = built === null
        ? produceManualEntries(slot.model as MarkdownModel, heads, { ...conditionOptions, name, noTree: true })
        : produceManualEntries(slot.model as MarkdownModel, heads, { ...conditionOptions, name, catalog: built });
      for (const entry of out.entries) entries.push({ ...entry, fragments: entry.fragments.map((f) => withSlot(f, name)) });
      for (const span of out.unplaced) unplaced.push({ ...span, fragment: withSlot(span.fragment, name) });
      warnings.push(...out.warnings.map((w) => `${name}：${w}`));
    }
    return { entries, unplaced, warnings };
  } catch (error) {
    if(error instanceof ApplicabilitySourceError)return {entries:[],warnings:[],incomplete:{missing:error.message,next_action:error.next_action}};
    
    return { entries, unplaced, warnings: [...warnings, internalError(error)] };
  }
}

/** Missing release status is local entry metadata, never a producer-wide incomplete result. */
export function releaseNotes(input:unknown):ProducerOutput{
 try{
  const slot=slotOf(input,'notes');if(!slot)return empty('没有发布说明来源');const build=buildName(input);
  if(slot.parser==='json@1'){const out=produceReleaseEntries(slot.model,build);return {entries:out.entries,warnings:out.warnings,grammar:{id:'famx-release-notes@2',source:'product:famx/README.md#release-notes',complete:out.complete===true}};}
  if(slot.parser==='html@1')return fixedBugEntries(slot.model,build);
  if(slot.parser!=='markdown@1')return empty('发布说明解析器未声明；下一步：'+STATUS_NEXT);
  const model=isRecord(slot.model)?slot.model:{},blocks=Array.isArray(model.blocks)?model.blocks:[];
  const block=blocks.find(row=>isRecord(row)&&typeof row.selector==='string');
  return {entries:isRecord(block)?[undeclaredReleaseEntry(build,slot.parser,block.selector as string,typeof block.text==='string'?block.text:'',null,undefined,'缺发布说明的结构化缺陷身份和状态')]:[],warnings:['缺发布说明的结构化状态；下一步：'+STATUS_NEXT]};
 }catch(error){return empty(internalError(error));}
}
