// Expected sources of a case-review run (pack function): the PLM stories and bugs its author declared. Only external
// object ids come out; the Hub reads them with the system packs and binds what it read (role expected) with its revision.
//
// Identifiers (famx-id-fields@1, declared for the owner's R6 rule 2026-10-24): an identifier comes from a whole field the
// author wrote — `bug:<decimal list>` or `story:<decimal list>` — in the title the source system lists or in a folder label
// above the document, or from the run parameters `stories` / `bugs`. Nothing is read out of prose: no marker word ("bug to
// case", "需求", "Story#", "PLM"), no misspelling of one, no unmarked number at the start, no padded or date-shaped number
// and no folded full-width form. Without a declared identifier the run binds no expected source and says what is missing
// and who declares it (the author writes the field or the parameters, or a model proposes the link with a verbatim quote
// the Hub verifies).
// Keyword retrieval selects no candidate source at all (owner rulings U19/U20, 2026-10-24): no spec search, no test
// strategy search and no similar-list hint is bound, and their results are neither an input nor a basis of recall.
import { PACK, failure, guarded, isRecord, warningSink, type WarningSink } from './common.ts';
import { clip, collapseWhitespace, isBlank, mustEncodeInExternalId, percentEncode, textOf } from './text.ts';
import type { ExternalObjectId, FoundId, IdKind, IdRange, SourceBasis, SourcesOutput } from './types.ts';

const DEFAULT_TERMS=8,MAX_TERMS=16,MAX_NAMED=20;
const KIND_LABEL: Record<IdKind,string>={story:'需求',bug:'缺陷'};
/** famx-id-fields@1: entire field 'bug:<decimal>' or 'story:<decimal>'; comma-separated decimal lists. Origin: owner R6, 2026-10-24. */
function fields(text:string): Array<{kind:'bug'|'story'|null;id:string}> {
  const match=/^(bug|story):([1-9][0-9]{0,11}(?:,[1-9][0-9]{0,11})*)$/.exec(text);
  return match ? match[2].split(',').map(id=>({kind:match[1] as 'bug'|'story',id})) : [];
}

export function markedIds(text:string):FoundId[]{return fields(text).map(f=>({...f,marker:f.kind,text}));}
export function leadingIds(_text:string):FoundId[]{return [];}
export function extractIds(text:string):FoundId[]{return markedIds(text);}
/** Source selection is by declared identities only; free-text retrieval is retired by R6. */
export function featureTerms(_title:string,_names:readonly string[]=[],_max=8):string[]{return [];}
export function specSearchId(_terms:readonly string[]):ExternalObjectId|null{return null;}
// The function ---------------------------------------------------------------------------------------------------------------

type BareIds = 'both' | IdKind | 'skip';
type Params = {
  stories: string[] | null;
  bugs: string[] | null;
  ranges: { story: IdRange | null; bug: IdRange | null } | null;
  bareIds: BareIds;
  specSearch: boolean;
  maxTerms: number;
};
const BARE_IDS = ['both', 'story', 'bug', 'skip'] as const satisfies readonly BareIds[];

function idList(value: unknown, name: string, warnings: WarningSink): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    warnings.note({ code: `${PACK}.parameter_ignored`, message: `参数 ${name} 不是数组，已忽略`, data: { parameter: name } });
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    const text = typeof entry === 'number' && Number.isSafeInteger(entry) ? String(entry) : typeof entry === 'string' ? entry.trim() : '';
    if (/^[1-9][0-9]{0,11}$/.test(text)) out.push(text);
    else warnings.note({ code: `${PACK}.parameter_ignored`, message: `参数 ${name} 里的 ${clip(String(textOf(entry) ?? typeof entry), 40).text} 不是编号，已忽略`, data: { parameter: name } });
  }
  return out;
}

/** One kind's range: absent (null), or `{ min?, max? }` with non-negative integer bounds, min <= max. */
const ID_RANGE_FIELDS = {min:true,max:true} satisfies Record<keyof IdRange,boolean>;

function readRange(value: unknown): IdRange | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value) || Object.keys(value).some(key=>!Object.hasOwn(ID_RANGE_FIELDS,key))) return undefined;
  const range: IdRange = {};
  for (const [key, bound] of Object.entries(value)) {
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0) return undefined;
    if (key === 'min') range.min = bound;
    else range.max = bound;
  }
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) return undefined;
  return range;
}

function readParams(raw: unknown, warnings: WarningSink): Params {
  const params: Params = { stories: null, bugs: null, ranges: null, bareIds: 'both', specSearch: false, maxTerms: DEFAULT_TERMS };
  if (!isRecord(raw)) return params;
  const ignored = (parameter: string, message: string): void => warnings.note({ code: `${PACK}.parameter_ignored`, message, data: { parameter } });
  params.stories = idList(raw.stories, 'stories', warnings);
  params.bugs = idList(raw.bugs, 'bugs', warnings);
  if (raw.idRanges !== undefined) {
    const ranges = isRecord(raw.idRanges) && Object.keys(raw.idRanges).every((key) => key === 'story' || key === 'bug') ? raw.idRanges : null;
    const story = ranges === null ? undefined : readRange(ranges.story);
    const bug = ranges === null ? undefined : readRange(ranges.bug);
    if (story === undefined || bug === undefined) ignored('idRanges', '参数 idRanges 应为 { story?: { min?, max? }, bug?: { min?, max? } }，边界是非负整数且 min 不大于 max；已忽略');
    else if (story !== null || bug !== null) params.ranges = { story, bug };
  }
  if (raw.bareIds !== undefined) {
    const bare = BARE_IDS.find((candidate) => candidate === raw.bareIds);
    if (bare !== undefined) params.bareIds = bare;
    else ignored('bareIds', '参数 bareIds 只能是 both、story、bug 或 skip，按 both 处理');
  }
  if (raw.specSearch !== undefined) {
    if (typeof raw.specSearch === 'boolean') params.specSearch = raw.specSearch;
    else ignored('specSearch', '参数 specSearch 不是布尔值，按 true 处理');
  }
  if (raw.maxTerms !== undefined) {
    if (typeof raw.maxTerms === 'number' && Number.isInteger(raw.maxTerms) && raw.maxTerms >= 1 && raw.maxTerms <= MAX_TERMS) params.maxTerms = raw.maxTerms;
    else ignored('maxTerms', `参数 maxTerms 应为 1 到 ${MAX_TERMS} 的整数，按 ${DEFAULT_TERMS} 处理`);
  }
  return params;
}

const inRange = (id: string, range: IdRange | null): boolean => {
  if (range === null) return true;
  const value = Number(id);
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
};

/** The kinds an id is read as, and how that was decided. */
function kindsOf(found: FoundId, params: Params): { kinds: IdKind[]; how: 'marker' | 'range' | 'bare' } {
  if (found.kind !== null) return { kinds: [found.kind], how: 'marker' };
  if (params.ranges !== null) {
    const story = inRange(found.id, params.ranges.story);
    const bug = inRange(found.id, params.ranges.bug);
    if (story !== bug) return { kinds: [story ? 'story' : 'bug'], how: 'range' };
  }
  const bare = params.bareIds;
  return { kinds: bare === 'both' ? ['story', 'bug'] : bare === 'skip' ? [] : [bare], how: 'bare' };
}

function rootText(model: unknown): string | null {
  if (!isRecord(model) || !Array.isArray(model.nodes) || model.nodes.length === 0) return null;
  const root = model.nodes[0];
  if (!isRecord(root)) return null;
  if (typeof root.text === 'string') return root.text;
  return isRecord(root.data) ? textOf(root.data.text) : null;
}

export function expectedSources(input: unknown): SourcesOutput {
  const warnings = warningSink();
  if (!isRecord(input) || !Array.isArray(input.documents)) {
    return failure('invalid_input', '输入里没有 documents 数组', '按 { documents: [{ documentId, model, title?, ancestors? }], product, parameters } 传入');
  }
  const params = readParams(input.parameters, warnings);
  const product = isRecord(input.product) && Array.isArray(input.product.names) ? input.product.names.filter((name): name is string => typeof name === 'string') : [];
  const external: ExternalObjectId[] = [];
  const basis: SourceBasis[] = [];
  const seen = new Set<string>();
  const unknownKind: string[] = [];
  const bind = (entry: SourceBasis): void => {
    if (seen.has(entry.external)) return;
    seen.add(entry.external);
    external.push(entry.external);
    basis.push(entry);
  };
  const explicit = params.stories !== null || params.bugs !== null;
  for (const [kind, ids] of [['story', params.stories], ['bug', params.bugs]] as const) {
    for (const id of ids ?? []) bind({ external: `plm:${kind}:${id}`, document: null, from: 'parameter', text: id, marker: null, reason: `调用方在参数里给出的${KIND_LABEL[kind]}编号` });
  }
  for (const [position, raw] of input.documents.entries()) {
    const documentId = isRecord(raw) ? textOf(raw.documentId) : null;
    if (!isRecord(raw) || documentId === null || isBlank(documentId)) {
      warnings.add({ code: `${PACK}.document_skipped`, message: `第 ${position + 1} 份文档缺少 documentId，没有读取它的期望来源`, data: { position } });
      continue;
    }
    const title = typeof raw.title === 'string' ? raw.title : null;
    const root = rootText(raw.model);
    const texts: Array<{ from: SourceBasis['from']; text: string; where: string }> = [];
    if (title !== null && !isBlank(title)) texts.push({ from: 'title', text: title, where: '标题' });
    if (root !== null && !isBlank(root) && collapseWhitespace(root) !== collapseWhitespace(title ?? '')) texts.push({ from: 'root', text: root, where: '脑图根节点' });
    const ancestors = Array.isArray(raw.ancestors) ? raw.ancestors.filter((label): label is string => typeof label === 'string' && !isBlank(label)) : [];
    for (const label of [...ancestors].reverse()) texts.push({ from: 'ancestor', text: label, where: `上级目录“${clip(collapseWhitespace(label), 40).text}”` });
    if (texts.length === 0) warnings.add({ code: `${PACK}.document_skipped`, message: `文档 ${documentId} 没有标题，读不出期望来源`, document: documentId });
    if (!explicit) {
      for (const { from, text, where } of texts) {
        for (const found of extractIds(text)) {
          const { kinds, how } = kindsOf(found, params);
          if (how === 'bare' && params.bareIds !== 'story' && params.bareIds !== 'bug' && !unknownKind.includes(found.id)) unknownKind.push(found.id);
          for (const kind of kinds) {
            const reason =
              how === 'marker'
                ? `${where}里的“${clip(found.text, 60).text}”标明是${KIND_LABEL[kind]}`
                : how === 'range'
                  ? `${where}里的编号 ${found.id} 没有标明类型，按缺陷系统的编号范围（参数 idRanges）是${KIND_LABEL[kind]}`
                  : params.bareIds === 'both'
                    ? `${where}里的编号 ${found.id} 没有标明是需求还是缺陷，需求和缺陷都读取：两种分开编号，都存在时其中一种可能与这份文档无关，引用前先核对记录的标题；不存在的那一种读取时记为不可用`
                    : `${where}里的编号 ${found.id} 没有标明类型，按参数 bareIds 当作${KIND_LABEL[kind]}`;
            bind({ external: `plm:${kind}:${found.id}`, document: documentId, from, text: clip(collapseWhitespace(text), 200).text, marker: found.marker, reason });
          }
        }
      }
    }
    const main = texts.find((entry) => entry.from !== 'ancestor');
    if (params.specSearch && main !== undefined) {
      const id = specSearchId(featureTerms(main.text, product, params.maxTerms));
      if (id !== null) bind({ external: id, document: documentId, from: main.from, text: clip(collapseWhitespace(main.text), 200).text, marker: null, reason: `${main.where}里的功能词，用来检索规格书` });
    }
  }
  if (unknownKind.length > 0) {
    const named = unknownKind.slice(0, MAX_NAMED);
    const list = `${named.slice(0, 5).join('、')}${unknownKind.length > 5 ? ' 等' : ''}`;
    warnings.note({
      code: `${PACK}.id_kind_unknown`,
      message:
        params.bareIds === 'both'
          ? `${unknownKind.length} 个编号没有标明是需求还是缺陷（${list}），需求和缺陷都读取；两种分开编号，都存在时其中一种可能与文档无关，引用前先核对记录的标题；给出编号范围（参数 idRanges），或用参数 stories、bugs 直接给出编号，可以只读对的那一种`
          : `${unknownKind.length} 个编号没有标明是需求还是缺陷（${list}），按参数 bareIds=skip 没有读取`,
      data: { ids: named, count: unknownKind.length, read: params.bareIds === 'both' ? 'both' : 'none' },
    });
  }
  if (!explicit && external.length===0) warnings.note({code:PACK+'.id_kind_unknown',message:'缺少显式来源编号；下一步作者用参数 stories、bugs 声明来源，或由模型提交逐字引文并经 Hub 核验；没有按正文检索候选'});
  return { external, basis, warnings: warnings.list() };
}

export default function (input: unknown): unknown {
  return guarded(() => expectedSources(input));
}
