// Helpers for runs of the review packs: scripted models (plain functions that build submissions), lookups into validation
// results, and an oracle over a KityMinder document written from the pack README's case rule (section "Case rule":
// `marked` (default) recognizes tagged nodes as well as untagged nodes outside every case that carry the case priority,
// have children and hold no tagged node and no node with the case priority — the team template's case marker;
// `tagged` restricts cases to nodes whose `resource` is a non-empty array), computed from the fixture bytes, never
// from a Hub answer. Still an independent implementation: only the README's words, nothing imported from hub/ or packs/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ItemProjection, RunSummary } from '../../../contracts/src/run.ts';
import type { ItemResult, RequirementResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { PARTITION, type Partition } from '../../../contracts/generated/vocabulary.ts';
import type { Answer, McpClient, Outputs } from './mcp.ts';

export type Item = ItemProjection;
export type SlotClaim = Record<string, unknown>;

export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

/** Display names and separately declared identities of scripted clients; no family is inferred from a name. */
export const DRAFTER = 'alpha-drafter 1.0 (scripted, temperature 0)';
export const VERIFIER = 'omega-checker 2.0 (scripted, temperature 0)';
/** A third explicitly declared synthetic family, for a second independent submission. */
export const OTHER_MODEL = 'kappa-reader 3.1 (scripted)';

export const DRAFTER_IDENTITY={model_id:'synthetic-drafter',model_family_id:'synthetic-family-alpha'};
export const VERIFIER_IDENTITY={model_id:'synthetic-checker',model_family_id:'synthetic-family-omega'};
export const OTHER_IDENTITY={model_id:'synthetic-reader',model_family_id:'synthetic-family-kappa'};

export function runOf(answer: Answer<Outputs['start_run']>): RunSummary {
  assert.equal(answer.isError, false, `start_run was refused: ${answer.text.slice(0, 1500)}`);
  assert.ok(answer.out.run, 'an ok answer carries the run');
  return answer.out.run;
}

export function resultOf(answer: Answer<Outputs['submit_result']>): ValidationResult {
  assert.ok(answer.out.result, `the receipt carries a result: ${answer.text.slice(0, 1500)}`);
  return answer.out.result;
}

/** Every item of a result with its partition. */
export function itemsOf(result: ValidationResult): Array<{ partition: Partition; item: ItemResult }> {
  const out: Array<{ partition: Partition; item: ItemResult }> = [];
  for (const partition of PARTITION) for (const item of result.partitions[partition] as ItemResult[]) out.push({ partition, item });
  return out;
}

export function itemResult(result: ValidationResult, id: string): { partition: Partition; item: ItemResult } {
  const found = itemsOf(result).filter((entry) => entry.item.item === id);
  assert.equal(found.length, 1, `item ${id} is in exactly one partition`);
  return found[0];
}

export function requirementOf(result: ValidationResult, id: string, key: string): RequirementResult {
  const found = itemResult(result, id).item.requirements.find((r) => r.requirement === key);
  assert.ok(found, `item ${id} has requirement ${key}`);
  return found;
}

/** The static layer terminal of one (item, requirement). */
export function staticLayer(result: ValidationResult, id: string, key: string) {
  const layer = requirementOf(result, id, key).layers.find((l) => l.layer === 'static');
  assert.ok(layer, `${id}/${key} has a static terminal`);
  return layer;
}

/** The codes of the refutations among an (item, requirement)'s claims. */
export function refutationCodes(result: ValidationResult, id: string, key: string): string[] {
  return requirementOf(result, id, key)
    .claims.filter((c) => c.statement.verdict === 'refute' && typeof c.statement.code === 'string')
    .map((c) => c.statement.code as string)
    .sort();
}

export const byLabel = (run: RunSummary, label: string): Item[] => run.items.filter((i) => i.label === label);
export const oneByLabel = (run: RunSummary, label: string): Item => {
  const found = byLabel(run, label);
  assert.ok(found.length > 0, `no item labelled ${label}`);
  return found[0];
};
export const itemById = (run: RunSummary, id: string): Item => {
  const found = run.items.find((i) => i.id === id);
  assert.ok(found, `no item ${id}`);
  return found;
};

export function sourceOf(run: RunSummary, prefix: string): string {
  const found = run.sources.find((s) => (s.external ?? '').startsWith(prefix));
  assert.ok(found, `no source ${prefix}: ${run.sources.map((s) => s.external).join(', ')}`);
  return found.reference;
}

/** A finding at the item's own location, quoting its title verbatim (the label is the title with white space collapsed). */
export function finding(item: Item, extra: SlotClaim = {}): SlotClaim {
  return {
    text: '只测了一个取值，缺少边界值的用例',
    code: 'edge_case_gap',
    rank: 'minor',
    location: item.location,
    quotes: [{ reference: item.location, text: item.label }],
    ...extra,
  };
}

/** The draft's level, a cross-item judgment of the run-level requirement `level`. */
export function level(rank = 'P4', grounds: string[] = []): Record<string, unknown> {
  return { nature: 'judgment', statement: `等级理由：合成的评审，等级 ${rank}；证据缺口：命令的已验证测试事实还没有`, grounds, code: 'level', rank };
}

/** A scripted drafting model: every item handled, the given findings where named, an empty list elsewhere. */
export function draft(run: RunSummary, findings: Map<string, SlotClaim[]> = new Map(), options: { model?: string; model_identity?: typeof DRAFTER_IDENTITY; context?: boolean; cross?: unknown[]; skip?: Map<string, string>; omit?: Set<string> } = {}) {
  const items = run.items
    .filter((i) => !(options.omit?.has(i.id) ?? false))
    .map((i) => {
      const reason = options.skip?.get(i.id);
      if (reason !== undefined) return { item: i.id, handling: 'skipped', reason };
      return {
        item: i.id,
        handling: 'handled',
        ...(options.context === false ? {} : { context: sha256(`context of ${i.id} ${i.digest ?? ''}`) }),
        // R3: this optional judgment is explicitly undeclared, never inferred from prose.
        slots: { findings: findings.get(i.id) ?? [], expected_quality: [] },
      };
    });
  return { run: run.run, model: options.model ?? DRAFTER, model_identity:options.model_identity??DRAFTER_IDENTITY, items, cross_item: options.cross ?? [level()] };
}

export async function startReview(client: McpClient, input: Record<string, unknown>): Promise<RunSummary> {
  return runOf(await client.call('start_run', { pack: 'case-review', ...input }));
}

// ---------------------------------------------------------------- the oracle over a KityMinder document

type Node = { data: { id?: string; text?: string; priority?: unknown; resource?: unknown; [key: string]: unknown }; children?: Node[] };

export interface OracleCase {
  nodeId: string;
  text: string;
  priority: unknown;
  tags: unknown[];
  /** Leaf children texts (a priority-3 leaf is a precondition, not an expected result). */
  expected: string[];
  /** Texts from the root down to the parent. */
  path: string[];
  /** Expected results below steps (children with children), in order. */
  stepExpected: string[];
  /** True when the case is recognized by the marker only (no tags) — the `marked` rule's addition. */
  markedOnly: boolean;
}

export type CaseRule = 'tagged' | 'marked';

const tagged = (n: Node): boolean => Array.isArray(n.data.resource) && (n.data.resource as unknown[]).length > 0;

/**
 * A marked case (the team template's case marker, from the README's words): an untagged node outside every case that
 * carries the case priority, has children, and holds no tagged node and no node with the case priority.
 */
const markedCase = (n: Node, casePriority: number): boolean => {
  if (tagged(n)) return false;
  if (n.data.priority !== casePriority) return false;
  if ((n.children ?? []).length === 0) return false;
  const holds = (node: Node): boolean => (node.children ?? []).some((c) => tagged(c) || c.data.priority === casePriority || holds(c));
  return !holds(n);
};

/** The cases of a document under a rule, in document order; `marked` (the default) also recognizes marked cases. */
export function oracleCases(document: { root: Node }, options: { rule?: CaseRule; groupPriority?: number; casePriority?: number } = {}): OracleCase[] {
  const rule = options.rule ?? 'marked';
  const groupPriority = options.groupPriority ?? 1;
  const casePriority = options.casePriority ?? 2;
  const holdsCase = (n: Node): boolean => (n.children ?? []).some((c) => tagged(c) || (rule === 'marked' && markedCase(c, casePriority)) || c.data.priority === casePriority || holdsCase(c));
  const isCase = (n: Node): boolean => (tagged(n) || (rule === 'marked' && markedCase(n, casePriority)));
  const out: OracleCase[] = [];
  const walk = (n: Node, path: string[]): void => {
    const isGroup = tagged(n) && n.data.priority === groupPriority && holdsCase(n);
    if (isCase(n) && !isGroup) {
      const leaves = (n.children ?? []).filter((c) => (c.children ?? []).length === 0);
      const steps = (n.children ?? []).filter((c) => (c.children ?? []).length > 0);
      out.push({
        nodeId: String(n.data.id ?? ''),
        text: String(n.data.text ?? ''),
        priority: n.data.priority ?? null,
        tags: (n.data.resource as unknown[]) ?? [],
        expected: leaves.filter((c) => c.data.priority !== 3).map((c) => String(c.data.text ?? '')),
        path,
        stepExpected: steps.flatMap((s) => (s.children ?? []).filter((c) => (c.children ?? []).length === 0).map((c) => String(c.data.text ?? ''))),
        markedOnly: !tagged(n),
      });
    }
    for (const child of n.children ?? []) walk(child, [...path, String(n.data.text ?? '')]);
  };
  walk(document.root, []);
  return out;
}

/** Nodes that look like a case but have no tags: the `untagged_cases` warning's count under the `tagged` rule. */
export function untaggedCandidates(document: { root: Node }, casePriority = 2): number {
  const cases = oracleCases(document, { rule: 'marked', casePriority });
  return cases.filter((c) => c.markedOnly).length;
}

/** Ids shared by several cases (the projection gives each copy its own pack identity). */
export function sharedIds(cases: OracleCase[]): Set<string> {
  const counts = new Map<string, number>();
  for (const c of cases) counts.set(c.nodeId, (counts.get(c.nodeId) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
}

/** Read every plain-text page of a projected string through the public MCP continuation instructions. */
export async function readProjectedText(client:McpClient,reference:string):Promise<{text:string;pages:string[]}> {
  const pages:string[]=[],seen=new Set<string>();let cursor:string|undefined,original:string|undefined,joined='';
  do{
    const answer=await client.call('get_nodes',{reference,...(cursor===undefined?{}:{cursor})});
    assert.equal(answer.isError,false,answer.text.slice(0,500));
    assert.equal(typeof answer.out.content?.text,'string');
    original??=answer.out.content!.text!;assert.equal(answer.out.content!.text,original);
    pages.push(answer.text);
    const lines=answer.text.split('\n'),head=lines.findIndex(line=>/^原文（.*：$/u.test(line));
    assert.ok(head>=0,'the value is emitted as plain original text, not JSON');
    const position=/从第 (\d+) 行(?:的第 (\d+) 个字符)?起：$/u.exec(lines[head]);
    const row=position?Number(position[1])-1:0,offset=position?.[2]?Number(position[2])-1:0;
    let start=0;for(let i=0;i<row;i++){start=original.indexOf('\n',start)+1;assert.ok(start>0);}
    start+=offset;
    let first=head+1;if(lines[first]?.startsWith('（接上页：'))first++;
    let end=lines.findIndex((line,index)=>index>=first&&(/^部分：/u.test(line)||/^追踪[ ：]/u.test(line)));
    if(end<0)end=lines.length;
    const chunk=lines.slice(first,end).join('\n');
    assert.ok(original.startsWith(chunk,start),'the displayed body preserves the projected string bytes');
    const gap=original.slice(joined.length,start);
    assert.ok(gap===''||gap==='\n','only a line boundary may separate consecutive page bodies');
    joined+=gap+chunk;
    const footer=lines.slice(end).join('\n');
    const next=/下一页：get_nodes (\{[^\n]+?\})/u.exec(footer);
    if(next){
      const args=JSON.parse(next[1]);assert.equal(args.reference,reference);assert.equal(typeof args.cursor,'string');
      assert.ok(!seen.has(args.cursor),'continuation makes progress');seen.add(args.cursor);cursor=args.cursor;
    }else cursor=undefined;
  }while(cursor!==undefined);
  assert.equal(joined,original,'all projected bytes were read without a JSON transcription');
  return {text:joined,pages};
}
