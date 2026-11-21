import {exactNode,parameterProblem,mentionsOf} from './structure.ts';
// The adoc producer's step between K1's placement and the Hub's fragment contract. K1 copies a block's selector verbatim
// into every fragment it makes and stamps its own parser key on it (markdown@1), so the mapped model hands K1 a citation
// key of its own (`cite/<block>`, k1-model.ts) and this module turns every fragment back into the shape the Hub
// verifies: the chapter file's digest in `source`, `text@1` as the parser, the plain `l/<a>-<b>` line selector of the
// verified range and the producer's own slot. K1's placement code is not changed by it. A byte range inside a mapped
// table's text is only how K1 names a row: the fragment of a row is that row's own source line, with no range. A
// fragment this module cannot resolve refuses the whole group instead of going out as a reference to nothing.
import type { FragmentRef, ProducedEntry, Unplaced } from '../../../../../contracts/src/product.ts';
import { produceManualEntries,ApplicabilitySourceError } from '../manual.ts';
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
    code: 'famx.adoc.catalog_reading_off',
    message: `${family === undefined ? '这一版本线' : `名称族 ${family}`}的手册槽给的是 catalog.json（${CATALOG_SCHEMA}），而这一线有 adoc 源：catalog.json 的过渡读法对有 adoc 源的版本线已停用，这一组没有读它，也没有产出`,
    next_action:
      '把这条线的手册源换成 adoc 文件表（主文件加目录里的各章，同一 SVN 修订号，属性集按名称族给），或让管理员撤掉这条线的 catalog.json 过渡源，然后重新同步；在换源之前这条线不产出，旧知识根不动',
  };
}

export interface AdocEntryOptions {
  known_builds?:readonly string[];
  models?:readonly string[];
  platforms?:readonly string[];
  components?:readonly string[];
  licenses?:readonly string[];
  deployment_forms?:readonly string[];
  /** The manual name of this name family; K1 composes `/manual/<name>/<章节路径>` from it. */
  name: string;
  /** The producer's input slot. A fragment carries it whenever the producer has more than one slot or a list slot. */
  slot?: string;
  /** The command heads of the build, when the build's tree is readable (K1's anchor check). */
  heads?: readonly string[] | null;
  /** The build's command catalog for placement; declared relations perform links and drift checks afterward. */
  catalog?: CommandCatalog | null;
}

export type Produced =
  | { ok: true; entries: ProducedEntry[]; unplaced: Unplaced[]; warnings: string[] }
  | { ok: false; error: { code: string; message: string; next_action: string }; incomplete?:{missing:string;next_action:string} };

/**
 * Places one family's mapped model with K1's own code and rewrites every fragment into the Hub's shape. Either every
 * fragment cites a verified line of a chapter file of this group, or the group produces nothing.
 */
export function produceAdocEntries(mapped: Mapped, options: AdocEntryOptions): Produced {
  let placed:ReturnType<typeof produceManualEntries>;
  const safeModel={...mapped.model,blocks:mapped.model.blocks.map(block=>({...block,kind:block.kind==='code_block'?'code_block':'adoc_content'}))};
  try{placed = produceManualEntries(safeModel, options.heads ?? null, {
    name: options.name,
    known_builds:options.known_builds,
    models:options.models,platforms:options.platforms,components:options.components,licenses:options.licenses,deployment_forms:options.deployment_forms,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  }catch(error){if(error instanceof ApplicabilitySourceError)return {ok:false,error:{code:error.code,message:error.message,next_action:error.next_action},incomplete:{missing:error.message,next_action:error.next_action}};throw error;}
  const unresolved: string[] = [];
  const fragmentOf = (fragment: { selector: string; range?: [number, number];applicability?:FragmentRef['applicability'] }, where: string): FragmentRef | null => {
    const cite = citationFor(mapped.model, fragment.selector, fragment.range);
    if (cite === null || cite.sha256 === '') {
      unresolved.push(`${where} 的片段 ${fragment.selector}${fragment.range === undefined ? '' : ` 范围 [${fragment.range[0]}, ${fragment.range[1]})`} 没有已核对的原文行`);
      return null;
    }
    return {
      ...(options.slot === undefined ? {} : { slot: options.slot }),
      ...(fragment.applicability===undefined?{}:{applicability:fragment.applicability}),
      source: cite.sha256,
      parser: ADOC_PARSER,
      selector: cite.selector,
    };
  };
  const entries: ProducedEntry[] = [];
  const bySelector=new Map(mapped.model.blocks.map((block,index)=>[block.selector!,{block,index}]));
  const byBlock=new Map<object,ProducedEntry>();
  const groups=new Map<number,typeof mapped.model.blocks>();
  for(const block of mapped.model.blocks){if(block.sourceGroup===undefined)continue;const group=groups.get(block.sourceGroup)??[];group.push(block);groups.set(block.sourceGroup,group);}
  const removed=new Set<ProducedEntry>(),order=new Map<ProducedEntry,[number,number]>();
  const add=(entry:ProducedEntry,block?:object,position?:[number,number])=>{entries.push(entry);if(block)byBlock.set(block,entry);order.set(entry,position??[Number.MAX_SAFE_INTEGER,0]);};
  const structuralWarnings:string[]=[];
  placed.entries.forEach((entry, index) => {
    const fragments: FragmentRef[] = [];
    for (const fragment of entry.fragments) {
      const rewritten = fragmentOf(fragment, `第 ${index + 1} 条（${entry.kind}）`);
      if (rewritten === null) return;
      fragments.push(rewritten);
    }
    const originalBlocks=entry.fragments.flatMap(fragment=>{const block=bySelector.get(fragment.selector)?.block;return block?[block]:[];});
    for(const block of originalBlocks)for(const cite of block.structuralSignature||mentionsOf(block.inline).length?block.paragraphCites??[]:[]){const extra:FragmentRef={...(options.slot?{slot:options.slot}:{}),source:cite.sha256,parser:ADOC_PARSER,selector:cite.selector};if(!fragments.some(fragment=>fragment.source===extra.source&&fragment.selector===extra.selector))fragments.push(extra);}
    // An example is reference only and takes no part in judgment (task item 6). K1 places its text like any other block
    // — under the command before it, with that command's words in `data` — so the mark rides on the entry: a reader, a
    // drift count or a review can tell example content from what the manual states.
    const reference = entry.fragments.length > 0 && entry.fragments.every((fragment) => citesExample(mapped.model, fragment.selector));
    if (!reference) {
      const blocks=entry.fragments.flatMap(fragment=>{const found=bySelector.get(fragment.selector)?.block;return found?[found]:[];});
      const data:Record<string,unknown>={...entry.data,manual_name:options.name};delete data.command_literals;delete data.signature_literals;
      const mentions=blocks.flatMap(block=>mentionsOf(block.inline));
      if(mentions.length){data.command_mentions=mentions;const matched=mentions.filter(literal=>{const tokens=literal.split(' ');return tokens.join(' ')===literal&&exactNode(options.catalog,tokens)!==null;});if(matched.length)data.command_literals=[...new Set(matched)];}
      const source=entry.fragments.map(fragment=>bySelector.get(fragment.selector)).find(Boolean);add({...entry,fragments,data},source?.block,source?[source.index,0]:undefined);return;
    }
    // Link declarations read top-level literal fields. Keep the source literals as reference data, outside that input.
    const data = { ...entry.data, manual_name:options.name, reference_only: true } as Record<string, unknown>;
    const referenceData: Record<string, unknown> = {};
    for (const field of ['command_literals', 'signature_literals', 'command_mentions']) {
      if (Object.hasOwn(data, field)) { referenceData[field] = data[field]; delete data[field]; }
    }
    const ownBlocks=entry.fragments.flatMap(fragment=>{const block=bySelector.get(fragment.selector)?.block;return block?[block]:[];});
    const mentions=ownBlocks.flatMap(block=>[...mentionsOf(block.inline),...(block.rowCites??[]).flatMap(row=>mentionsOf(row.inline))]);if(mentions.length)referenceData.command_mentions=mentions;
    if (Object.keys(referenceData).length > 0) data.reference = referenceData;
    const source=entry.fragments.map(fragment=>bySelector.get(fragment.selector)).find(Boolean);add({ ...entry, fragments, data },source?.block,source?[source.index,0]:undefined);
  });
  // K1 supplies the applicability scope; engine rows, not Markdown signatures, supply each table statement.
  for(const block of mapped.model.blocks.filter(block=>block.kind==='table')){
    const original=fragmentOf({selector:block.selector!},'表格');if(!original)continue;
    const entry=byBlock.get(block);
    if(!entry)continue;removed.add(entry);let rowIndex=0;
    for(const row of block.rowCites??[]){
      if(row.authored===false)continue;
      const fragment=fragmentOf({selector:block.selector!,range:row.range},'表格行');if(!fragment)continue;
      const statement=Buffer.from(block.text,'utf8').subarray(...row.range).toString('utf8');
      add({...entry,statement,data:{...entry.data,form:'table_row',...(mentionsOf(row.inline).length?{command_mentions:mentionsOf(row.inline),...(mentionsOf(row.inline).filter(literal=>exactNode(options.catalog,literal.split(' '))!==null).length?{command_literals:mentionsOf(row.inline).filter(literal=>exactNode(options.catalog,literal.split(' '))!==null)}:{})}:{})},fragments:[fragment,...entry.fragments.filter(other=>other.source!==original.source||other.selector!==original.selector)]},undefined,[bySelector.get(block.selector!)!.index,rowIndex++]);
    }
  }
  for(const block of mapped.model.blocks){
    const signature=block.structuralSignature;if(!signature||block.example)continue;
    const fragment=fragmentOf({selector:block.selector!},'结构签名');if(!fragment)continue;
    const nodes=signature.words.map(words=>exactNode(options.catalog,words));
    if(!options.catalog){structuralWarnings.push(`${block.cite.file}:${block.cite.selector}：缺锁定命令树；下一步绑定命令树后重产，未判漂移`);continue;}
    const unresolved=nodes.some(node=>node===null);
    const missing=signature.words.filter((_,index)=>nodes[index]===null&&signature.drift_slots[index]).map(words=>words.join(' '));
    const existing=byBlock.get(block);
    if(missing.length&&existing){existing.data={...existing.data,form:'signature_drift',signature_literals:[{primary:missing[0],alternatives:missing}],drift:{missing,next_action:'手册与命令树维护者核对这条完整定义后重产'}};structuralWarnings.push(`${block.cite.file}:${block.cite.selector}：结构签名漂移：${missing.join('、')}；下一步核对手册与锁定树后重产`);}
    const chapter=byBlock.get(block);
    if(chapter&&!unresolved){for(const part of block.sourceGroup===undefined?[block]:groups.get(block.sourceGroup)??[block]){const entry=byBlock.get(part);if(entry)removed.add(entry);}}
    const inherited={...(chapter?.data??{})};delete inherited.command_literals;delete inherited.command_mentions;delete inherited.drift;
    for(let index=0;index<nodes.length;index++){
      const node=nodes[index];if(!node)continue;const problem=parameterProblem(signature,node.signatures);
      if(problem)structuralWarnings.push(`${block.cite.file}:${block.cite.selector}：${signature.command}：${problem}`);
      add({kind:'definition',path:node.path,statement:signature.command+(signature.parameters?' '+signature.parameters:''),data:{...inherited,form:'signature',words:signature.words[index],signature:signature.command,params:signature.params,parameter_authorities:node.signatures.map(row=>({reference:row.reference??null,params:row.params})),signature_literals:[{primary:signature.words[index]!.join(' '),alternatives:[signature.words[index]!.join(' ')]}],signature_structure:'famx-adoc-signature-structure@1',parameters_verified:!problem,...(problem?{missing:problem,next_action:'核对锁定命令树的参数声明和手册原件后重产'}:{})},fragments:chapter?.fragments??[fragment],applicability:chapter?.applicability??null},undefined,[bySelector.get(block.selector!)!.index,index+1]);
    }
  }
  const unplaced: Unplaced[] = [];
  placed.unplaced.forEach((span, index) => {
    const fragment = fragmentOf(span.fragment, `第 ${index + 1} 个未归位片段`);
    if (fragment !== null) unplaced.push({ ...span, fragment });
  });
  if (unresolved.length > 0) {
    return {
      ok: false,
      error: {
        code: 'famx.adoc.fragment_not_cited',
        message: `有 ${unresolved.length} 个片段翻不成 text@1 引用，整组没有产出：${unresolved.slice(0, 5).join('；')}${unresolved.length > 5 ? ' 等' : ''}`,
        next_action:
          '这些片段的选择器不是本映射发出的引用键，或者它指的块、表格行没有已核对的原文行；核对映射（尤其表格行的引用）后按同一修订号重跑。失败结果不能替换旧知识根。',
      },
    };
  }
  // K1 only extracts literals; the shared relation evaluator performs links and drift checks from product declarations.
  const warnings = [...mapped.warnings, ...placed.warnings,...structuralWarnings];
  const literalsOf = (entry: ProducedEntry): string[] => isRecord(entry.data.reference) ? asStrings(entry.data.reference.command_mentions??entry.data.reference.command_literals) : [];
  const reference = entries.filter(entry => entry.data.reference_only === true && literalsOf(entry).length > 0);
  if (reference.length > 0) {
    warnings.push(
      `有 ${reference.length} 条标为参考（data.reference_only）的条目带命令字面，共 ${new Set(reference.flatMap(literalsOf)).size} 个。` +
        '示例不参与命令关系判定：字面保留在 data.reference，不写入共用关系核验器读取的顶层字段。读时视图、评审与回归核对原文时仍要按 data.reference_only 分流参考条目；本包不改 K1。',
    );
  }
  return { ok: true, entries:entries.filter(entry=>!removed.has(entry)).sort((a,b)=>order.get(a)![0]-order.get(b)![0]||order.get(a)![1]-order.get(b)![1]), unplaced, warnings };
}
