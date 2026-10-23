import { readFile } from 'node:fs/promises';
import { Hub, type Piece } from './hub.ts';
import { record, need, sha } from './local.ts';
const generated = JSON.parse(await readFile(new URL('../generated.json', import.meta.url), 'utf8'));
export const EGRESS = JSON.parse(await readFile(new URL('../egress.json', import.meta.url), 'utf8'));
export { generated as GENERATED };
export const PACK_REF = `${generated.id}@${generated.version}`;
export const defaultKind = (kind: string): boolean => EGRESS.default_entry_kinds.includes(kind);
export function allowedKinds(send: string[]): Set<string> {
  need(send.every((code) => code === 'src' || generated.axes.entry_kind.some((v: any) => v.code === code)), '--send 类别不存在；使用技能 generated.json 中的条目种类或 src'); return new Set([...EGRESS.default_entry_kinds, ...send]);
}
export function treeReference(reference: string) {
  const match = /^tree:([a-f0-9]{64})(\/[^@]*)@([a-f0-9]{64})$/.exec(reference);
  need(match, '需要 tree: 条目引用；从 Hub get_nodes 照抄完整引用'); return { root: match[1]!, path: match[2]!, entry: match[3]! };
}
export async function readPiece(hub: Hub, id: string, reference: string, allowed: Set<string>): Promise<Piece> {
  need(typeof reference === 'string', '片段缺少 reference；从 Hub 重新读取'); let kind: string;
  let statement: string | null = null;
  if (reference.startsWith('tree:')) {
    const ref = treeReference(reference); const nodes = await hub.nodes(ref.root, [ref.path], 0); const entry = nodes.flatMap((node) => node.entries).find((v: any) => v.reference === reference);
    need(entry && generated.axes.entry_kind.some((v: any) => v.code === entry.kind), 'Hub 没有给出该条目的种类；重新读取完整节点'); kind = entry.kind; statement = entry.statement;
  } else { need(/^src:[a-f0-9]{64}\//.test(reference), '只收 tree: 条目或带选择器的 src: 片段引用；重新读取精确引用'); kind = 'src'; }
  need(allowed.has(kind), '该种类默认不外发；需要本次明确 --send 并经所有者确认，或改用允许的手册片段');
  const value = await hub.call('get_nodes', { reference }); const content = value.content;
  need(value.call_result === 'ok' && record(content) && content.read_tier === generated.model_readable && content.readable === true && typeof content.text === 'string', `源不是${generated.axes.read_tier.find((v:any)=>v.code===generated.model_readable).label}或没有可读原文；Hub 说明：${typeof content?.note==='string'?JSON.stringify(content.note):'没有可外发的正文'}；补齐可读源后重跑，不能选择加入绕过档位`);
  const text = statement ?? content.text; need(typeof text === 'string' && text !== '', '片段没有原文；从 Hub 补取后重跑');
  return { id, reference, kind, text, sha256: sha(text), bytes: Buffer.byteLength(text) };
}
