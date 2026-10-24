import {isReleaseStatus,RELEASE_STATUS_LABEL} from './generated/vocabulary.ts';
// The join of the traceability matrix: the defects of the build (the defect index of its release notes) against the case
// index keyed by the defect ids the case documents carry. Ids compare after the digit normalisation of ids.ts; both sides
// are grouped by the normalised id first, so the join is a lookup, not a cross product. Deterministic: every list is sorted
// in code-unit order and nothing depends on the member order of the views.
import { normalizeId } from './ids.ts';
import { clip, compareText, strings } from './text.ts';
import type { CaseRef, IndexViewData, MatrixRow, ViewEntry } from './types.ts';

/** The defect statuses an entry may carry (data.status of a release-note defect entry). */
export const STATUS_TEXT: Readonly<Record<string, string>> = RELEASE_STATUS_LABEL;
/** The short forms, for the conflict enumeration. */
export const STATUS_SHORT: Readonly<Record<string, string>> = RELEASE_STATUS_LABEL;

/** The status part of a summary or a statement: one status, or the conflict spelled out. */
export function statusText(statuses: readonly string[]): string {
  if (statuses.length > 1) return `状态矛盾（${statuses.map((s) => STATUS_SHORT[s] ?? s).join('、')}）`;
  return statuses.length === 1 ? (STATUS_TEXT[statuses[0]] ?? statuses[0]) : '状态未知';
}

/** A definite collision note for separate identities in two named defect systems. */
export function systemNote(systems: readonly string[]): string {
  return systems.length > 1 ? `；系统 ${systems.join('、')} 已确认同号撞号` : '';
}

/** The item summary: the status and the number of cases; an untraced defect says unknown, never a failure. */
export function summaryOf(row: Pick<MatrixRow, 'statuses' | 'cases' | 'systems' | 'collision_systems' | 'ambiguous_cases'>): string {
  const ambiguous=row.ambiguous_cases?.length ?? 0;
  const traced = (row.collision_systems?.length ?? 0)>1 ? `${row.cases.length} 个已明确系统用例；当前视图有 ${ambiguous} 个用例未带系统` : ambiguous>0 ? `当前视图有 ${ambiguous} 个同号用例系统待补（未知）` : row.cases.length > 0 ? `${row.cases.length} 个用例` : '无已索引用例（未知）';
  return clip(`${statusText(row.statuses)}；${traced}${systemNote(row.collision_systems ?? row.systems)}`, 200);
}

/** A case entry as the matrix lists it: the case's node id (data.node, what the cases producer writes), else data.case,
 * else the digest. */
function caseRefOf(digest: string, entry: ViewEntry): CaseRef {
  const data = entry.data;
  const id = typeof data.node === 'string' && data.node !== '' ? data.node : typeof data.case === 'string' && data.case !== '' ? data.case : digest;
  const title = typeof data.title === 'string' && data.title !== '' ? data.title : entry.statement;
  const document = typeof data.document === 'string' && data.document !== '' ? data.document : null;
  const defects = [...new Set(strings(data.defects))].sort(compareText);
  return { case: id, title, document, reference: entry.reference, defects, entry: digest, ...(typeof data.system==='string'&&data.system!==''&&data.system!=='unknown'?{system:data.system}:{}) };
}

/**
 * The matrix: one row per system and normalised bug id the defects view lists with a selected status. The statuses filter applies to
 * the defect entries; a bug whose entries are all filtered out is no item at all. Case entries missing from the view's
 * entries record (warned about at the reading) simply take no part.
 */
export function buildMatrix(defects: IndexViewData, cases: IndexViewData, statuses: readonly string[]): MatrixRow[] {
  // The case index, re-keyed by the normalised id: normalised id -> digest -> entry.
  const byBug = new Map<string, Map<string, ViewEntry>>();
  for (const [raw, digests] of Object.entries(cases.keys)) {
    const norm = normalizeId(raw);
    let bucket = byBug.get(norm);
    if (bucket === undefined) byBug.set(norm, (bucket = new Map()));
    for (const digest of digests) {
      const entry = cases.entries[digest];
      if (entry !== undefined) bucket.set(digest, entry);
    }
  }
  // The defects, grouped by the normalised id: one bug may be written with leading zeros in one entry and plain in another.
  const groups = new Map<string, { bug:string; system:string|null; ids: Set<string>; entries: Map<string, ViewEntry> }>();
  const buckets=Object.entries(defects.keys),indexed=new Set(buckets.flatMap(([,digests])=>digests));
  const unkeyed=Object.keys(defects.entries).filter(digest=>!indexed.has(digest)&&defects.entries[digest].data.identity_declaration_status==='undeclared');if(unkeyed.length)buckets.push(['',unkeyed]);
  for (const [raw, digests] of buckets) {
    const norm = normalizeId(raw);
    for (const digest of digests) {
      const entry = defects.entries[digest];
      if (entry === undefined) continue;
      const status = entry.data.status;
      const declared=entry.data.declaration_status==='declared'&&isReleaseStatus(status);
      if(declared&&!statuses.includes(status))continue;
      const system=typeof entry.data.system==='string'&&entry.data.system!==''&&entry.data.system!=='unknown'?entry.data.system:null;
      const missingIdentity=entry.data.bug===null||entry.data.identity_declaration_status==='undeclared';
      const key=JSON.stringify([system,missingIdentity?digest:norm]);
      let group=groups.get(key);
      if(group===undefined)groups.set(key,(group={bug:missingIdentity?'':norm,system,ids:new Set(),entries:new Map()}));
      if(!missingIdentity)group.ids.add(raw);
      group.entries.set(digest, entry);
    }
  }
  const rows: MatrixRow[] = [];
  const byNumber=new Map<string,Array<typeof groups extends Map<string,infer G>?G:never>>();
  for(const group of groups.values())byNumber.set(group.bug,[...(byNumber.get(group.bug)??[]),group]);
  for (const group of groups.values()) {
    const bug=group.bug, peers=byNumber.get(bug)!;
    const collisionSystems=[...new Set(peers.flatMap(g=>g.system===null?[]:[g.system]))].sort(compareText);
    const ambiguous:CaseRef[]=[];
    const entries = [...group.entries.entries()].sort(([a], [b]) => compareText(a, b));
    const declaredEntries=entries.filter(([,entry])=>entry.data.declaration_status==='declared'&&isReleaseStatus(entry.data.status));
    const declaration_status=declaredEntries.length===entries.length?'declared' as const:'undeclared' as const;
    const statusList = [...new Set(declaredEntries.map(([, entry]) => entry.data.status as string))].sort(compareText);
    const systemList = [...new Set(entries.map(([, entry]) => entry.data.system).filter((system): system is string => typeof system === 'string' && system !== ''))].sort(compareText);
    const bucket = byBug.get(bug);
    const caseRefs: CaseRef[] = [];
    if (bucket !== undefined) {
      for (const [digest, entry] of bucket){
        const kase=caseRefOf(digest,entry);
        if(kase.system ? kase.system===group.system : peers.length===1)caseRefs.push(kase);
        else if(!kase.system)ambiguous.push(kase);
      }
      caseRefs.sort((a, b) => compareText(a.case, b.case) || compareText(a.document ?? '', b.document ?? '') || compareText(a.reference, b.reference));
    }
    rows.push({
      bug,
      declaration_status,
      ...(bug===''?{identity_declaration_status:'undeclared' as const}:{}),
      ...(declaration_status==='undeclared'?{missing:'发布说明缺陷条目的原始结构状态'+(bug===''?'及缺陷身份':''),next_action:'发布页或缺陷系统维护者补原始 status、身份和所属构建，重读来源并重产；依赖已修复状态的判断补齐前保持未知'}:{}),
      identity:bug===''?'undeclared:'+entries[0][0]:group.system===null?bug:encodeURIComponent(group.system)+':'+bug,
      ...(collisionSystems.length>1?{collision_systems:collisionSystems,collision_references:peers.flatMap(g=>[...g.entries.values()].map(e=>e.reference)).sort(compareText)}:{}),
      ...(ambiguous.length?{ambiguous_cases:ambiguous.sort((a,b)=>compareText(a.reference,b.reference))}:{}),
      ids: [...group.ids].sort(compareText),
      statuses: statusList,
      conflict: statusList.length > 1,
      statement: entries[0][1].statement,
      references: entries.map(([, entry]) => entry.reference).sort(compareText),
      digests: entries.map(([digest]) => digest),
      cases: caseRefs,
      systems: systemList,
    });
  }
  rows.sort((a, b) => compareText(a.bug,b.bug)||compareText(a.identity??'',b.identity??''));
  return rows;
}
