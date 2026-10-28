import type { CommandIdentity } from '../../../../contracts/generated/shared-interfaces.ts';
// Synthetic knowledge:index reader inputs, never a product-command parser.
import { createHash } from 'node:crypto';
import type { BoundInput } from '../../../../contracts/src/pack.ts';
import type { IndexView } from '../../../../contracts/src/views.ts';
export const ROOT = createHash('sha256').update('synthetic template command root').digest('hex');
export const BUILD = 'Rel_MEADOW_10_6_8_1';
export const PRODUCT = 'synthetic-template';
export const LOCK = { product: PRODUCT, names: ['Synthetic Template'], line: '10.6', build: BUILD, root: ROOT, parameters: {}, groups: [] };
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const commandIdentity=(path:string):CommandIdentity=>({tree_root:ROOT,path,signature:`tree:${ROOT}${path}`,parameters:[]});
export type IndexedCase = { document: string; node: string; commands: string[]; title: string; path_labels: string[] };
export function indexView(cases: IndexedCase[], only = [...new Set(cases.map(c => c.document))].sort()): IndexView {
  const entries: IndexView['entries'] = {}; const keys: IndexView['keys'] = {};
  for (const c of cases) {
    const entry = digest(JSON.stringify(c));
    entries[entry] = { entry, kind: 'case', statement: '', data: { ...c, command_identities:c.commands.map(commandIdentity), command_tree_root:ROOT }, reference: `tree:${ROOT}/cases@${entry}` };
    (keys[c.document] ??= []).push(entry);
  }
  for (const key of Object.keys(keys)) keys[key]!.sort();
  return { schema: 'index-view@1', product: PRODUCT, build: { build: BUILD, root: ROOT }, kind: 'case', key: 'document', keys, entries, fields: ['document', 'node', 'commands', 'command_identities', 'title', 'path_labels', 'command_tree_root'], only, cut_keys: [], total_keys: Object.keys(keys).length, total_entries: Object.keys(entries).length, truncated: false, skipped: 0, notes: [] };
}
export function bindIndex(view: unknown): BoundInput {
  return { slot: 'case_index', external: `knowledge:index:${PRODUCT}:${BUILD}?kind=case&key=document&only=${(view as IndexView).only?.join(',') ?? ''}&fields=document,node,commands,command_identities,title,path_labels,command_tree_root`, sha256: digest(JSON.stringify(view)), media_type: 'application/json', parser: 'json@1', model: view, meta: null };
}

/** Assign invented command paths to the fixture's declared case nodes, without parsing their text. */
export function assignedCases(document: import('./mindmap.ts').DocumentSpec, id: string, commands: (node: string) => string[] = () => ['/CLI/widget/probe']): IndexedCase[] {
  const out: IndexedCase[] = [];
  const walk = (nodes: import('./mindmap.ts').NodeSpec[], path: string[]) => { for (const node of nodes) {
    const title = node.kind === 'case' ? node.title : node.text;
    if (node.kind === 'case' || node.kind === 'node' && node.untagged) out.push({ document: id, node: node.id, commands: commands(node.id), title, path_labels: path });
    walk(node.children, [...path, title]);
  } };
  walk(document.children, [document.title]); return out;
}
