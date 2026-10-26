import {commandLines} from './commands.ts';
// The case index of the product (product@1 producer `cases`, ProducerInput -> ProducerOutput, entry kind case). Inputs:
// `documents` (the build's case documents, agile:case ids, a list slot handed in batches), `tree` (the build's command tree:
// the catalog the commands resolve against, built with the command-tree producer's functions) and `folders` (the agile tree
// the plan located the documents in, agile:tree:roots: each document's title and the folders above it).
// For every case node of every document (cases-nodes.ts: the tagged or the marked rule, a case once) the command phrases of
// its title and of the labels above it are resolved against the catalog (cases-commands.ts). A case gives ONE entry per
// resolved command, filed at the command's node, or, when no command resolves, one entry with path null that the Hub's
// typed-judgment model places (brief section 6a.4; without a calibrated model it stays unplaced but citable, K04 R[3]). The
// entries of a case share their statement (every data field, K02 R[4]), their data and their one fragment (the case node's
// selector in its document), applicability null. An entry depends on its own document only.
//
// Which agile document an element is: the content of an agile:case read names it in the wrapper member `agile: {id}`
// (model.meta.agile.id), so every element carries its identity however the Hub cuts the list into calls; an element that
// carries its own external id is taken at its word. The id must be one the build lists. An element without either is a
// document of unknown identity (document, line, train and module null), never guessed from its position.
import {labelOf} from './generated/vocabulary.ts';
import type { ProducedEntry, ProducerOutput } from '../../../../contracts/src/product.ts';
import { commandCatalog, textCommands, stepCommands, type CommandCatalog } from './cases-commands.ts';
import { MAX_DEPTH, caseKeys, caseNodes, type CaseNode } from './cases-nodes.ts';
import { AGILE_ID, CASE_DOCUMENTS_ROLE, CASE_MEMBER, CASE_PREFIX, CASE_TREE_ID, MINDMAP_PREFIX, isBlank, negativeOf, tagDeclaration } from './cases-rules.ts';
import { idsFromTitle } from './ids.ts';
import { locateFromAncestors } from './locate.ts';
import { lineKey } from './naming.ts';
import type { EntryKind, XmlModel } from './types.ts';
import { compareDigits, compareText, internalError, isRecord } from './util.ts';

const KIND: EntryKind = 'case';
const LIST_SLOT = 'documents';
const PARSER = 'kityminder@1';
const UNKNOWN_DOCUMENT = '未知文档';
const MAX_EXAMPLES = 20;
const MAX_TITLE = 1000;
const MAX_LABEL = 200;
const MAX_LABELS = 32;
const MAX_TAGS = 20;
const MAX_TAG = 100;
const SHA256 = /^[0-9a-f]{64}$/;

/** One authored body reader for production and feeding. Child branches remain steps; when the case has only
 * expectation leaves, its own text is the operation body. Lines use the existing exact-line command slot reader.
 * Original numbering, check markers, whitespace and wording are retained; no command-shaped text is extracted. */
export function caseBody(node:CaseNode):{steps:Array<{text:string}>;expects:Array<{text:string}>}{
 const branches=node.stepTexts??[];
 const texts=branches.length?branches:node.expectedCount>0?commandLines(node.title).map(line=>line.text).filter(text=>text.length>0):[];
 return {steps:texts.map(text=>({text})),expects:(node.expectedTexts??[]).map(text=>({text}))};
}

// ---------------------------------------------------------------- text helpers

/** Storable text: NUL removed, lone surrogates replaced, at most `max` code points (an ellipsis marks a cut). */
export function storable(text: string, max: number): string {
  let out = '';
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) continue;
    if (count >= max) return `${out}…`;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else out += '�';
    } else if (code >= 0xdc00 && code <= 0xdfff) out += '�';
    else out += text[i];
    count++;
  }
  return out;
}

const byNumber = (a: string, b: string): number => compareDigits(a, b) || compareText(a, b);

// ---------------------------------------------------------------- the statement

/** Words a statement writes for absent and boolean values; a text value equal to one of them is quoted. */
const WORDS = new Set(['无', '未知', '是', '否', '未标注', UNKNOWN_DOCUMENT]);
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** A text value as a statement writes it: as it is when that cannot be mistaken, else as a JSON string. */
function textValue(text: string, separators: RegExp): string {
  const plain = text !== '' && text === text.trim() && !/[\r\n"]/.test(text) && !separators.test(text) && !WORDS.has(text);
  return plain ? text : JSON.stringify(text);
}

const FIELD = /[；]/;
const ITEM = /[；、]/;
const LABEL = /[；›]/;

const valueOf = (value: unknown, absent: string): string => (typeof value === 'string' ? textValue(value, FIELD) : value === null || value === undefined ? absent : JSON.stringify(value));
const listOf = (value: unknown, separator: string, pattern: RegExp): string => {
  const items = Array.isArray(value) ? value : [];
  return items.length === 0 ? '无' : items.map((item) => (typeof item === 'string' ? textValue(item, pattern) : JSON.stringify(item))).join(separator);
};
const yesNo = (value: unknown, absent: string): string => (value === true ? '是' : value === false ? '否' : absent);

/**
 * The canonical statement of a case entry: what every data field says, in a fixed order (K02 R[4]: the entry's digest covers
 * the normalised statement). The first line is the key and the title; the title is repeated exactly when its line shows it
 * with its white space folded. Texts that could be mistaken for a separator or a word of the statement are JSON strings.
 */
export function caseStatement(data: Record<string, unknown>): string {
  const document = typeof data.document === 'string' ? data.document : null;
  const title = typeof data.title === 'string' ? data.title : '';
  const lines = [`${document ?? UNKNOWN_DOCUMENT}:${String(data.node)} | ${oneLine(title)}`];
  lines.push(`文档：${valueOf(document, '未知')}；节点：${valueOf(data.node, '无')}`);
  if (oneLine(title) !== title) lines.push(`标题：${JSON.stringify(title)}`);
  lines.push(`上级节点：${listOf(data.path_labels, ' › ', LABEL)}`);
  const priority = typeof data.priority === 'string' ? JSON.stringify(data.priority) : valueOf(data.priority, '无');
  lines.push(`优先级：${priority}；标签：${listOf(data.tags, '、', ITEM)}；负向：${yesNo(data.negative, '未标注')}`);
  if (data.tags_note === '正负向和测试类型未声明') lines.push(data.tags_note);
  lines.push(`期望结果：${valueOf(data.expected_count, '无')} 条（${data.has_expected === true ? '有内容' : '没有内容'}，${labelOf('judgment_status','unjudged')}）；步骤：${valueOf(data.steps_count, '无')} 个`);
  lines.push(`原件：${valueOf(data.source_sha256, '未知')}；用例位置：${valueOf(data.case_location, '未知')}`);
  lines.push(`命令：${listOf(data.commands, '、', ITEM)}`);
  lines.push(`需求：${listOf(data.stories, '、', ITEM)}；缺陷：${listOf(data.defects, '、', ITEM)}`);
  lines.push(`版本线：${valueOf(data.line, '未知')}；发布火车：${valueOf(data.train, '未知')}；模块：${valueOf(data.module, '未知')}`);
  lines.push(`自动化编号：${valueOf(data.autoid, '无')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- which document each element is

/** The ids a build lists in a role (a role of one id is a list of one), first occurrences in order, as the Hub reads them. */
export function listedIds(build: unknown, role: string): string[] {
  const sources = isRecord(build) && isRecord(build.sources) ? build.sources : {};
  const value = sources[role];
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return [...new Set(list)];
}

/** The agile document id of an external id of the case index (agile:case, or the review read agile:mindmap), or null. */
function documentKey(external: string): string | null {
  for (const prefix of [CASE_PREFIX, MINDMAP_PREFIX]) {
    if (external.startsWith(prefix)) {
      const id = external.slice(prefix.length).split('@')[0];
      return AGILE_ID.test(id) ? id : null;
    }
  }
  return null;
}

/** The document id an element's content names (the agile:case wrapper member in model.meta), or its own external id names. */
export function elementDocument(element: unknown): string | null {
  if (!isRecord(element)) return null;
  const meta = isRecord(element.model) && isRecord(element.model.meta) ? element.model.meta : null;
  const member = meta !== null && isRecord(meta[CASE_MEMBER]) ? (meta[CASE_MEMBER] as Record<string, unknown>) : null;
  if (member !== null && typeof member.id === 'string' && AGILE_ID.test(member.id)) return member.id;
  return typeof element.external === 'string' ? documentKey(element.external) : null;
}

/**
 * The agile document id of every element, or null: unknown when the element names none, or names one the build does not list
 * (when the build lists the role at all). `anonymous` and `unlisted` count the two.
 */
export function elementDocuments(elements: readonly unknown[], build: unknown): { documents: Array<string | null>; anonymous: number; unlisted: number } {
  const sources = isRecord(build) && isRecord(build.sources) ? build.sources : {};
  const listed = Object.hasOwn(sources, CASE_DOCUMENTS_ROLE) ? new Set(listedIds(build, CASE_DOCUMENTS_ROLE).map(documentKey).filter((id): id is string => id !== null)) : null;
  let anonymous = 0;
  let unlisted = 0;
  const documents = elements.map((element) => {
    const id = elementDocument(element);
    if (id === null) {
      anonymous++;
      return null;
    }
    if (listed !== null && !listed.has(id)) {
      unlisted++;
      return null;
    }
    return id;
  });
  return { documents, anonymous, unlisted };
}

type Folder = { title: string | null; ancestors: string[] };

/** The documents of the agile tree slot (json@1 model of agile:tree:roots content) by id; null when it is not that. */
export function treeFolders(slot: unknown): Map<string, Folder> | null {
  if (!isRecord(slot) || slot.parser !== 'json@1' || !isRecord(slot.model) || !Array.isArray(slot.model.documents)) return null;
  const out = new Map<string, Folder>();
  for (const doc of slot.model.documents as unknown[]) {
    if (!isRecord(doc) || typeof doc.id !== 'string' || out.has(doc.id)) continue;
    const ancestors = Array.isArray(doc.ancestors) ? doc.ancestors.filter((a): a is string => typeof a === 'string') : [];
    out.set(doc.id, { title: typeof doc.title === 'string' ? doc.title : null, ancestors });
  }
  return out;
}

// ---------------------------------------------------------------- the producer

type Example = { reason: 'no_phrase' | 'unresolved'; text: string };

function examplesText(examples: readonly Example[], reason: Example['reason']): string {
  const own = examples.filter((e) => e.reason === reason).map((e) => e.text);
  return own.length === 0 ? '' : `（例如：${own.join('；')}）`;
}

/** Producer entry (product.json producer `cases`). */
export function cases(input: unknown): ProducerOutput {
  const warnings: string[] = [];
  try {
    const record = isRecord(input) ? input : {};
    const rawPhrases=isRecord(record.params)&&record.params.command_phrases===true;
    const slots = isRecord(record.slots) ? record.slots : {};
    const lists = isRecord(record.lists) ? record.lists : {};
    const batch = isRecord(record.batch) ? record.batch : null;
    const elements = Array.isArray(lists[LIST_SLOT]) ? (lists[LIST_SLOT] as unknown[]) : [];
    const count = (value: unknown, add: number): string => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value + add) : '?');
    const where = batch === null ? '' : `第 ${count(batch.index, 1)}/${count(batch.of, 0)} 批：`;
    if (elements.length === 0) {
      if (batch === null || batch.of === 1) warnings.push(rawPhrases?'这个不分版本范围没有列出用例文档':'这个构建没有列出用例文档');
      return { entries: [], warnings,...(rawPhrases&&isRecord(slots.folders)?{inventory:[{label:'未覆盖用例',listed:{slot:'folders',parser:'json@1',selector:'p/documents'},complete:{slot:'folders',parser:'json@1',selector:'p/complete'},selected:0}]}:{}) };
    }
    const tree = isRecord(slots.tree) ? slots.tree : null;
    let catalog: CommandCatalog;
    if (tree === null || tree.parser !== 'xml@1') {
      warnings.push(rawPhrases?`${where}不分版本范围不带命令树，这一批 ${elements.length} 份文档的命令短语照录，用例条目保留为未归位`:`${where}没有命令树（或不是 XML），这一批 ${elements.length} 份文档的用例都不能按命令归档，各记一条不带路径的条目`);
      catalog = { root: { children: new Map(), path: null }, heads: [], size: 0 };
    } else {
      const built = commandCatalog(tree.model as XmlModel, typeof tree.sha256==='string'?tree.sha256:undefined);
      catalog = built.catalog;
      for (const warning of built.warnings) warnings.push(`${where}${warning}`);
      if (catalog.size === 0) warnings.push(`${where}命令树里没有命令，这一批 ${elements.length} 份文档的用例都记为不带路径的条目`);
    }
    const folders = treeFolders(slots.folders);
    if (folders === null) warnings.push(`${where}敏捷平台的用例树（${CASE_TREE_ID}）没有读到或格式不对：文档的标题和上级目录未知，版本线、发布火车、模块和目录里的编号记为未知`);
    const identity = elementDocuments(elements, record.build);
    if (identity.anonymous > 0) warnings.push(`${where}${identity.anonymous} 份文档的内容没有写明是敏捷平台的哪份文档（不是 ${CASE_PREFIX}<编号> 读到的内容），它们的用例的文档编号、版本线、发布火车、模块和目录里的编号记为未知`);
    if (identity.unlisted > 0) warnings.push(`${where}${identity.unlisted} 份文档写明的编号不在这个构建的用例文档清单里，按未知文档处理`);
    return produce(elements, identity.documents, folders, catalog, where, warnings,rawPhrases);
  } catch (error) {
    return { entries: [], warnings: [...warnings, internalError(error)] };
  }
}

type Located = { line: string | null; train: string | null; module: string | null };

function produce(elements: readonly unknown[], documents: ReadonlyArray<string | null>, folders: Map<string, Folder> | null, catalog: CommandCatalog, where: string, warnings: string[],rawPhrases=false): ProducerOutput {
  const counts = { documents: 0, cases: 0, filed: 0, toPlace: 0, noPhrase: 0, unresolved: 0, noCase: 0, notMindmap: 0, repeated: 0, malformed: 0, deep: 0, notInTree: 0 };
  const parsers = new Set<string>();
  // 1. The case nodes of every usable document: a known document once, an unknown one wherever it is.
  type Doc = { sha256: string; document: string | null; folder: Folder | null; cases: CaseNode[]; keys: string[] };
  const docs: Doc[] = [];
  const seen = new Set<string>();
  elements.forEach((raw, k) => {
    if (!isRecord(raw) || typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
      counts.notMindmap++;
      parsers.add('?');
      return;
    }
    if (raw.parser !== PARSER) {
      counts.notMindmap++;
      parsers.add(String(raw.parser).slice(0, 40));
      return;
    }
    const document = documents[k] ?? null;
    if (document !== null) {
      if (seen.has(document)) {
        counts.repeated++;
        return;
      }
      seen.add(document);
    }
    counts.documents++;
    const scan = caseNodes(raw.model);
    counts.malformed += scan.malformed;
    counts.deep += scan.deep;
    if (scan.cases.length === 0) {
      counts.noCase++;
      return;
    }
    const folder = document === null || folders === null ? null : (folders.get(document) ?? null);
    if (document !== null && folders !== null && folder === null) counts.notInTree++;
    docs.push({ sha256: raw.sha256, document, folder, cases: scan.cases, keys: caseKeys(raw.model, scan.cases, document ?? '') });
  });

  // 2. The commands of every distinct title and label, in one scan.
  const textIndex = new Map<string, number>();
  const texts: string[] = [];
  const indexOf = (text: string): number => {
    let at = textIndex.get(text);
    if (at === undefined) {
      at = texts.length;
      texts.push(text);
      textIndex.set(text, at);
    }
    return at;
  };
  for (const doc of docs) for (const node of doc.cases) [node.title, ...node.path, ...node.bodyTexts].forEach(indexOf);
  const scanned = textCommands(catalog, texts);
  for (const warning of scanned.warnings) warnings.push(`${where}${warning}`);

  // 3. Ids by text (case title, labels above it, the document's title and folders) and locations by document, cached.
  const idCache = new Map<string, { stories: string[]; bugs: string[] }>();
  const idsOf = (text: string): { stories: string[]; bugs: string[] } => {
    let found = idCache.get(text);
    if (found === undefined) {
      const ids = idsFromTitle(text);
      found = { stories: ids.stories, bugs: ids.bugs };
      idCache.set(text, found);
    }
    return found;
  };
  const locationOf = (doc: Doc): Located => {
    if (doc.folder === null) return { line: null, train: null, module: null };
    const at = locateFromAncestors(doc.folder.ancestors);
    return { line: at.line === null ? null : lineKey(at.line), train: at.train, module: at.module };
  };

  // 4. The entries of every case: one per resolved command, else one for placement.
  const entries: ProducedEntry[] = [];
  const examples: Example[] = [];
  const example = (reason: Example['reason'], doc: Doc, node: CaseNode, key: string): void => {
    if (examples.length >= MAX_EXAMPLES || examples.filter((e) => e.reason === reason).length >= MAX_EXAMPLES / 2) return;
    examples.push({ reason, text: `${doc.document ?? UNKNOWN_DOCUMENT}:${key}「${storable(oneLine(node.title), 30)}」` });
  };
  for (const doc of docs) {
    const located = locationOf(doc);
    doc.cases.forEach((node, k) => {
      counts.cases++;
      const key = doc.keys[k];
      const results = [node.title, ...node.path, ...node.bodyTexts].map((text) => scanned.results[textIndex.get(text) as number]);
      const paths = [...new Set(results.flatMap(r => (r.identities ?? []).map(identity => identity.path)))].sort(compareText);
      if (paths.length === 0) {
        counts.toPlace++;
        if (results.reduce((sum, r) => sum + r.phrases, 0) === 0) {
          counts.noPhrase++;
          example('no_phrase', doc, node, key);
        } else {
          counts.unresolved++;
          example('unresolved', doc, node, key);
        }
      } else counts.filed++;
      const idTexts = [node.title, ...node.path, ...(doc.folder === null ? [] : [...(doc.folder.title === null ? [] : [doc.folder.title]), ...doc.folder.ancestors])];
      const stories = new Set<string>();
      const defects = new Set<string>();
      for (const text of idTexts) {
        const ids = idsOf(text);
        ids.stories.forEach((id) => stories.add(id));
        ids.bugs.forEach((id) => defects.add(id));
      }
      const body=caseBody(node),operations=stepCommands(catalog,body.steps);
      const declaration = tagDeclaration(node.resource);
      const data: Record<string, unknown> = {
        document: doc.document,
        node: storable(key, MAX_TITLE),
        title: storable(node.title, MAX_TITLE),
        path_labels: node.path.slice(0, MAX_LABELS).map((label) => storable(label, MAX_LABEL)),
        priority: typeof node.priority === 'string' ? storable(node.priority, MAX_TAG) : node.priority,
        tags: node.tags.slice(0, MAX_TAGS).map((tag) => storable(tag, MAX_TAG)),
        negative: declaration.negative,
        test_type_status: declaration.status,
        test_types: declaration.types,
        tag_ids: declaration.ids,
        tag_valid: declaration.valid,
        resource_empty: node.resource === undefined || (Array.isArray(node.resource) && node.resource.length === 0),
        resource: node.resource ?? null,
        tag_declaration: declaration,
        ...(!node.tags.some(tag => !isBlank(tag)) ? {tags_note:'正负向和测试类型未声明'} : {}),
        expected_count: node.expectedCount,
        has_expected: node.hasExpected,
        source_sha256: doc.sha256,
        case_location: `src:${doc.sha256}/${PARSER}/${node.selector}`,
        steps_count: body.steps.length,
        step_texts:body.steps.map(step=>step.text),
        step_command_identities:operations.commands,
        unparsed_steps:operations.unparsed_steps,
        commands: paths,
        command_identities: results.flatMap(r=>r.identities??[]),
        command_tree_root: catalog.tree_root ?? null,
        ...(node.caseStructure!==undefined?{case_structure:node.caseStructure,case_structure_author_declared:true}:{}),
        stories: [...stories].sort(byNumber),
        defects: [...defects].sort(byNumber),
        line: located.line,
        train: located.train === null ? null : storable(located.train, MAX_LABEL),
        module: located.module === null ? null : storable(located.module, MAX_LABEL),
        autoid: node.autoid === null ? null : storable(node.autoid, MAX_TAG),
      };
      const statement = caseStatement(data);
      if(rawPhrases)data.command_phrases=[];
      const fragments = [{ slot: LIST_SLOT, source: doc.sha256, parser: PARSER, selector: node.selector }];
      for (const path of paths.length === 0 ? [null] : paths) entries.push({ kind: KIND, path, statement, data, fragments, applicability: null });
    });
  }

  // 5. What the call could not file by command, counted by reason.
  const toPlace =
    counts.toPlace === 0
      ? ''
      : `，${counts.toPlace} 个用例没引用目录里的任何命令，各保留一条可引用的不带路径条目：` +
        [
          ...(counts.noPhrase > 0 ? [`${counts.noPhrase} 个的标题、上级节点、步骤和预期行里没有能提取的命令短语${examplesText(examples, 'no_phrase')}`] : []),
          ...(counts.unresolved > 0 ? [`${counts.unresolved} 个提取到的命令短语在这个构建的命令目录里都解析不出${examplesText(examples, 'unresolved')}`] : []),
        ].join('，');
  warnings.push(`${where}${counts.documents} 份文档、${counts.cases} 个用例；${counts.filed} 个用例按命令归档${toPlace}；共 ${entries.length} 条`);
  if (counts.notInTree > 0) warnings.push(`${where}${counts.notInTree} 份文档不在敏捷平台的用例树里：标题和上级目录未知，版本线、发布火车、模块和目录里的编号记为未知`);
  if (counts.notMindmap > 0) warnings.push(`${where}${counts.notMindmap} 份文档不是 KityMinder 脑图（解析器 ${[...parsers].join('、')}），没有读`);
  if (counts.noCase > 0) warnings.push(`${where}${counts.noCase} 份文档里没有用例节点`);
  if (counts.repeated > 0) warnings.push(`${where}${counts.repeated} 份文档在这次调用里出现了不止一次（同一个文档编号），只读一次`);
  if (counts.malformed > 0 || counts.deep > 0) warnings.push(`${where}脑图结构有 ${counts.malformed} 处异常${counts.deep > 0 ? `，${counts.deep} 个子树超过 ${MAX_DEPTH} 层没有读` : ''}`);
  return { entries, warnings };
}

/** Pack function entry: ProducerInput -> ProducerOutput (product.json producer `cases`). */
export default function casesProducer(input: unknown): ProducerOutput {
  return cases(input);
}
