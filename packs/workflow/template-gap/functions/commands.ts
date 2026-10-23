// Command membership is read only from the admitted index; category membership uses the existing template matcher.
import { categoryFacts, MAX_EVIDENCE, type Template } from './template.ts';
import { compareText, type CaseIndex } from './index.ts';
import type { DocumentCases } from './cases.ts';
import type { CaseCategory, CaseRevisionNodes, CategoryFact, CommandCoverage, Skip } from './types.ts';
export function caseCategories(template: Template, cases: DocumentCases, facts?: CategoryFact[]): CaseCategory[] {
  const members = new Map(cases.cases.map(c => [c.id, [] as string[]]));
  for (const category of facts ?? categoryFacts(template, cases, { evidenceLimit: Infinity }))
    for (const id of category.evidence) members.get(id)!.push(category.id);
  const records = new Map(cases.cases.map(record => [record.id, record]));
  return [...members].sort(([a], [b]) => compareText(a, b)).map(([id, categories]) => ({ id, visit: records.get(id)!.visit, categories }));
}
/** One shared ancestor graph, with non-header leaf text omitted; never duplicate a long label per case. */
export function caseRevisionNodes(cases: DocumentCases): CaseRevisionNodes {
  const needed = new Set<number>();
  for (const record of cases.cases) {
    for (let at = record.visit; at !== -1 && !needed.has(at); at = cases.nodes.parents[at]!) needed.add(at);
  }
  return { texts: cases.nodes.texts.map((text, at) => needed.has(at) ? text : ''), parents: Array.from(cases.nodes.parents) };
}
export function indexedCommands(index: CaseIndex | null, document: string): string[] {
  if (!index) return [];
  return [...new Set((Object.hasOwn(index.keys, document) ? index.keys[document]! : []).flatMap(d => index.entries[d]!.data.commands as string[]))].sort(compareText);
}
function unplacedCount(notes: string[]): number | null {
  const descriptions = notes.filter(n => n.includes('未归位'));
  if (!descriptions.length) return 0;
  const parsed = /^未归位条目 ([0-9]+) 个，标在根下$/.exec(descriptions[0]!);
  return descriptions.length === 1 && parsed && Number.isSafeInteger(Number(parsed[1])) ? Number(parsed[1]) : null;
}
export function commandCoverage(template: Template, document: string, cases: CaseCategory[], index: CaseIndex | null, skips: Skip[], uploaded = false, lock: { root?: unknown; build?: unknown } = {}, caseRule: 'marked' | 'tagged' = 'marked', nodes?: CaseRevisionNodes): CommandCoverage {
  const revision = (title: string, labels: string[]): string => JSON.stringify([title, ...labels]);
  const normal = (text: string): string => text;
  const forms = nodes?.texts.map(normal) ?? [];
  const rows = new Map<string, { commands: Set<string>; references: Set<string>; revisions: Set<string>; title: string; labels: string[] }>();
  if (index && !uploaded) for (const digest of Object.hasOwn(index.keys, document) ? index.keys[document]! : []) {
    const entry = index.entries[digest]!; const node = entry.data.node as string;
    let row = rows.get(node); if (!row) { row = { commands: new Set(), references: new Set(), revisions: new Set(), title: normal(entry.data.title as string), labels: (entry.data.path_labels as string[]).map(normal) }; rows.set(node, row); }
    for (const command of entry.data.commands as string[]) row.commands.add(command);
    row.references.add(entry.reference);
    row.revisions.add(revision(entry.data.title as string, entry.data.path_labels as string[]));
  }
  const sameRevision = (fact: CaseCategory, row: { title: string; labels: string[] }): boolean => {
    if (!nodes || forms[fact.visit] !== row.title) return false;
    let at = nodes.parents[fact.visit]!;
    for (let i = row.labels.length - 1; i >= 0; i--) {
      if (at < 0 || forms[at] !== row.labels[i]) return false;
      at = nodes.parents[at]!;
    }
    return at === -1;
  };
  const unmatched: string[] = [];
  const matched = (caseRule === 'marked' ? cases : []).flatMap(fact => {
    const key = fact.id.slice(document.length + 1); const row = rows.get(key);
    if (!row || !fact.id.startsWith(`${document}:`) || row.revisions.size !== 1 || !sameRevision(fact, row)) { unmatched.push(fact.id); return []; }
    return [{ fact, row }];
  });
  const currentKeys = new Set(cases.map(fact => fact.id.slice(document.length + 1)));
  const orphaned = [...rows.keys()].filter(key => !currentKeys.has(key)).sort(compareText);
  const categories = template.categories.filter(c => c.group === 'command');
  const commands = (uploaded || caseRule !== 'marked' ? [] : [...new Set(matched.flatMap(m => [...m.row.commands]))].sort(compareText)).map(command => {
    const chosen = matched.filter(m => m.row.commands.has(command));
    const skipped = categories.flatMap(category => {
      const skip = skips.find(s => s.category === category.id && (s.command === undefined || s.command === command));
      return skip ? [{ ...skip }] : [];
    });
    const facts = categories.map(category => {
      const evidence = chosen.filter(m => m.fact.categories.includes(category.id)).sort((a,b) => compareText(a.fact.id,b.fact.id));
      return { id: category.id, label: category.label, group: category.group, required: true, present: evidence.length > 0, count: evidence.length, evidence: evidence.slice(0, MAX_EVIDENCE).map(m => m.fact.id), references: [...new Set(evidence.slice(0, MAX_EVIDENCE).flatMap(m => [...m.row.references]))].sort(compareText) };
    });
    return { command, caseCount: chosen.length, categories: facts, missing: facts.filter(c => !c.present && !skipped.some(s => s.category === c.id)).map(c => c.id), skipped, references: [...new Set(chosen.flatMap(m => [...m.row.references]))].sort(compareText) };
  });
  return { case_rule: caseRule, rule_mismatch: caseRule !== 'marked', bound: index !== null, uploaded, documentIndexed: index !== null && Object.hasOwn(index.keys, document), root: index?.build.root ?? (typeof lock.root === 'string' ? lock.root : null), build: index?.build.build ?? (typeof lock.build === 'string' ? lock.build : null), caseCount: cases.length, matchedCases: matched.length, unmatched: unmatched.sort(compareText), orphaned, commandlessCases: matched.filter(m => m.row.commands.size === 0).length, truncated: index?.truncated ?? false, skippedSources: index?.skipped ?? 0, cutKeys: index?.cut_keys ?? [], unplacedRoot: index ? unplacedCount(index.notes) : null, notes: index?.notes ?? [], commands };
}
