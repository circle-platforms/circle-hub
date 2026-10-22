// Helpers for runs of the review packs: scripted models (plain functions that build submissions), lookups into validation
// results, and an oracle over a KityMinder document written from the brief's case rule (section 6: a case is a node with a
// non-empty `resource` tag array; its children are the expected results; a tagged node with the group priority that holds
// cases is a group), computed from the fixture bytes, never from a Hub answer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ItemProjection, RunSummary } from '../../../contracts/src/run.ts';
import type { ItemResult, RequirementResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { PARTITION, type Partition } from '../../../contracts/generated/vocabulary.ts';
import type { Answer, McpClient, Outputs } from './mcp.ts';

export type Item = ItemProjection;
export type SlotClaim = Record<string, unknown>;

export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

/** Declared models of two families: the Hub compares the words of the names, these share none (engine decision 19). */
export const DRAFTER = 'alpha-drafter 1.0 (scripted, temperature 0)';
export const VERIFIER = 'omega-checker 2.0 (scripted, temperature 0)';
/** A third family, for a second independent submission. */
export const OTHER_MODEL = 'kappa-reader 3.1 (scripted)';

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
export function draft(run: RunSummary, findings: Map<string, SlotClaim[]> = new Map(), options: { model?: string; context?: boolean; cross?: unknown[]; skip?: Map<string, string>; omit?: Set<string> } = {}) {
  const items = run.items
    .filter((i) => !(options.omit?.has(i.id) ?? false))
    .map((i) => {
      const reason = options.skip?.get(i.id);
      if (reason !== undefined) return { item: i.id, handling: 'skipped', reason };
      return {
        item: i.id,
        handling: 'handled',
        ...(options.context === false ? {} : { context: sha256(`context of ${i.id} ${i.digest ?? ''}`) }),
        slots: { findings: findings.get(i.id) ?? [] },
      };
    });
  return { run: run.run, model: options.model ?? DRAFTER, items, cross_item: options.cross ?? [level()] };
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
}

const tagged = (n: Node): boolean => Array.isArray(n.data.resource) && (n.data.resource as unknown[]).length > 0;

/** The cases of a document under the brief's tagged rule, in document order. */
export function oracleCases(document: { root: Node }, groupPriority = 1, casePriority = 2): OracleCase[] {
  const holdsCase = (n: Node): boolean => (n.children ?? []).some((c) => tagged(c) || c.data.priority === casePriority || holdsCase(c));
  const out: OracleCase[] = [];
  const walk = (n: Node, path: string[]): void => {
    const isGroup = tagged(n) && n.data.priority === groupPriority && holdsCase(n);
    if (tagged(n) && !isGroup) {
      const leaves = (n.children ?? []).filter((c) => (c.children ?? []).length === 0);
      const steps = (n.children ?? []).filter((c) => (c.children ?? []).length > 0);
      out.push({
        nodeId: String(n.data.id ?? ''),
        text: String(n.data.text ?? ''),
        priority: n.data.priority ?? null,
        tags: n.data.resource as unknown[],
        expected: leaves.filter((c) => c.data.priority !== 3).map((c) => String(c.data.text ?? '')),
        path,
        stepExpected: steps.flatMap((s) => (s.children ?? []).filter((c) => (c.children ?? []).length === 0).map((c) => String(c.data.text ?? ''))),
      });
    }
    for (const child of n.children ?? []) walk(child, [...path, String(n.data.text ?? '')]);
  };
  walk(document.root, []);
  return out;
}

/** Ids shared by several cases (the projection gives each copy its own pack identity). */
export function sharedIds(cases: OracleCase[]): Set<string> {
  const counts = new Map<string, number>();
  for (const c of cases) counts.set(c.nodeId, (counts.get(c.nodeId) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
}
