import {authorTexts} from './command-policy.ts';
import {commandLines} from './generated/command-grammar.ts';
import {selectedExpectedNodes} from './expected-nodes.ts';
import {planCommands,deviceCommandLines} from './plan-commands.ts';
// Frozen raw inputs are revalidated on every check. This pack only verifies the authored plan slots.
import { checkContractShape } from './checks.ts';
import { isRecord } from './text.ts';
import { parseRuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall } from './profile.ts';
import { parseManifest } from './manifest.ts';
import { readSlots } from './slots.ts';
import { bindArguments, hasBalancedCommandText } from './binding.ts';
import type { LeaseRow } from './bed.ts';
/**
 * One criterion declaration the Hub froze into this run after an account other than the author accepted it (W10, B03
 * R[0]): the whole text is resolved by the core, the pack only reads the fields it needs and compares them exactly.
 */
export interface FrozenItemCriterion {
  /** Where the criterion was in the sources bound to the declaring run. */
  criterion: string;
  assertion: string;
  old: string;
  /** The accepted new criterion: an expectation may be a verbatim fragment of exactly this text. */
  new: string;
  /** The quotes that carry the new criterion; each one is re-verified verbatim in this run's own boundary (B03 R[3]). */
  grounds: Array<{ reference: string; quote: string }>;
  /** rec: of the declaration in the submission, and of the review result; the account that accepted it. */
  declaration: string;
  review: string;
  reviewer: string;
  target: string;
}

/**
 * The frozen accepted criterion declarations of one item, by exact field shape and exact item identity. Nothing is read
 * out of any text: a declaration the core did not freeze for this item does not exist as far as this pack is concerned.
 */
export function criteriaOf(context: unknown, item: string): FrozenItemCriterion[] {
  const accepted = isRecord(context) && Array.isArray(context.accepted_criteria) ? context.accepted_criteria : [];
  const out: FrozenItemCriterion[] = [];
  for (const value of accepted) {
    if (!isRecord(value) || value.item !== item) continue;
    const grounds = Array.isArray(value.grounds)
      ? value.grounds.filter(isRecord).map((ground) => ({ reference: typeof ground.reference === 'string' ? ground.reference : '', quote: typeof ground.quote === 'string' ? ground.quote : '' })).filter((ground) => ground.reference !== '' && ground.quote !== '')
      : [];
    const text = (name: string): string => (typeof value[name] === 'string' ? (value[name] as string) : '');
    if (text('new') === '' || text('declaration') === '' || text('review') === '' || text('reviewer') === '' || grounds.length === 0) continue;
    out.push({ criterion: text('criterion'), assertion: text('assertion'), old: text('old'), new: text('new'), grounds, declaration: text('declaration'), review: text('review'), reviewer: text('reviewer'), target: text('target') });
  }
  return out;
}

/** The frozen declaration an expectation cites, by exact reference equality; null when it cites none of them. */
export function citedCriterion(criteria: readonly FrozenItemCriterion[], reference: string): FrozenItemCriterion | null {
  return criteria.find((criterion) => criterion.declaration === reference) ?? null;
}

export interface PlanSubject { expected_nodes?:unknown; command_catalog?:unknown;command_identities?:unknown; item: string; location: string | null; data: unknown; contract: unknown; profile: unknown; manifest: unknown; leases: LeaseRow[]; now: string; case_texts: string[]; criteria: FrozenItemCriterion[] }
export function planDataOf(record: Record<string, unknown>): unknown {
  const slots = isRecord(record.slots) ? record.slots : {};
  const plan = Array.isArray(slots.plan) ? slots.plan[0] : slots.plan;
  return isRecord(plan) ? isRecord(plan.data) ? plan.data : plan : undefined;
}
export function planSubject(input: unknown): PlanSubject {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups : [];
  const group = groups.find((v) => isRecord(v) && v.kind === 'case-compile');
  const frozen = isRecord(group) ? group : {};
  const leases = isRecord(frozen.leases) ? frozen.leases : {};
  const item = isRecord(raw.item) ? raw.item : {};
  const id = typeof raw.item === 'string' ? raw.item : typeof item.id === 'string' ? item.id : '';
  return { expected_nodes:selectedExpectedNodes(isRecord(item.fields)?item.fields.expected_nodes:undefined,planDataOf(raw)),command_catalog:Array.isArray(raw.catalog)&&typeof context.root==='string'?{root:context.root,complete:raw.catalog_complete===true,entries:raw.catalog,...(context.command_policy!==undefined?{policy:context.command_policy}:{}),...(typeof raw.catalog_missing==='string'?{missing:raw.catalog_missing}:{})}:undefined,command_identities:isRecord(item.fields)?item.fields.command_identities:undefined,case_texts: authoredCaseTexts(item.fields), item: id, location: typeof raw.location === 'string' ? raw.location : typeof item.location === 'string' ? item.location : null, data: planDataOf(raw), contract: frozen.contract, profile: frozen.profile, manifest: frozen.manifest, leases: Array.isArray(leases.entries) ? leases.entries as LeaseRow[] : [], now: typeof leases.now === 'string' ? leases.now : new Date(0).toISOString(), criteria: criteriaOf(context, id) };
}
export function commandSubject(input:unknown):unknown{return planSubject(input);}
export function quoteSubject(input: unknown): unknown {
  const subject = planSubject(input); const outcomes = checkContractShape({subject}); const gap = outcomes.find(v => v.verdict === 'unknown'); if (gap) return { item: subject.item, location: subject.location, missing: gap.missing, reason: gap.reason }; const blocked=outcomes.filter(v=>v.verdict==='refute'&&v.pointer&&v.code).map(v=>({check:'contract_shape',pointer:v.pointer!,code:v.code!}));if(blocked.length)return {blocked}; const read = readSlots(subject.data); const contract = parseRuntimeContract(subject.contract); const beds = parseManifest(subject.manifest);
  const profile = contract.ok && beds.ok ? parseProfile(subject.profile, contract.contract, beds.beds) : null;
  // quote@1 has no required option: an explicit missing-field record produces missing_input, never a fictitious quote.
  if (!read.ok || !contract.ok || !beds.ok || !profile?.ok) return { item: subject.item, quotes: [{}], unreadable: true };
  // An expectation taken from a frozen accepted criterion cites the declaration, which quote@1 cannot read as a source:
  // what has to be verbatim in an expected source of this run is the declaration's own grounds (W10 step two, B03 R[3]).
  const quotes = read.slots.expects.flatMap((v) => {
    const criterion = citedCriterion(subject.criteria, v.quote.reference);
    return criterion === null || criterion.new !== v.quote.text ? [v.quote] : criterion.grounds.map((ground) => ({ reference: ground.reference, text: ground.quote }));
  });
  return { item: subject.item, quotes };
}

/** Authored source text is distinct from the model's final step values. */
export function authoredCaseTexts(value: unknown): string[] {return authorTexts(value);}

/** Workbook input is frozen by projection; only original metadata and current submitted slots are joined here. */
export function workbookSubject(input: unknown): unknown {
  const raw = isRecord(input) ? input : {}; const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups : []; const group = groups.find((v) => isRecord(v) && v.kind === 'case-compile');
  const frozen = isRecord(group) ? group : {}; const item = isRecord(raw.item) ? raw.item : {};
  const subject=planSubject(input),contract=parseRuntimeContract(subject.contract),manifest=parseManifest(subject.manifest),slots=readSlots(subject.data);const profile=contract.ok&&manifest.ok?parseProfile(subject.profile,contract.contract,manifest.beds):null;const catalog=contract.ok&&profile?.ok&&slots.ok?planCommands(contract.contract,profile.profile,slots.slots,subject.command_catalog).catalog:null;
  return {...subject,fields:{...(isRecord(item.fields)?item.fields:{}),expected_nodes:subject.expected_nodes,command_catalog:catalog},workbook:frozen.workbook??null,generation:frozen.generation??null,manifest_sha256:frozen.manifest_sha256??null};
}

/** Only frozen contract/profile roles choose device CLI slots; no scanning prose or author identities. */
export function selectCommandCatalog(input:unknown):unknown{
 const subject=planSubject(input),contract=parseRuntimeContract(subject.contract),manifest=parseManifest(subject.manifest),slots=readSlots(subject.data);
 const profile=contract.ok&&manifest.ok?parseProfile(subject.profile,contract.contract,manifest.beds):null;
 const lines=contract.ok&&profile?.ok&&slots.ok?deviceCommandLines(contract.contract,profile.profile,slots.slots).map(value=>value.line):[];
 const raw=isRecord(input)?input:{},context=isRecord(raw.context)?raw.context:{};
 return {base:'/commands',lines:[...new Set([...lines,...subject.case_texts.flatMap(text=>commandLines(text).map(line=>line.text))])]};
}
