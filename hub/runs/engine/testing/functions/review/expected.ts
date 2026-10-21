// Synthetic pack function (toy-review): the expected sources of a mind map. Story ids in the root text, the manual of the
// commands, a historical list as a hint, and one source no resource can read (to show an unavailable source is recorded).

interface Bound {
  slot: string;
  model: { nodes?: { text: string }[] } | null;
}

export default function expected(input: unknown): unknown {
  const inputs = ((input as { inputs?: Bound[] }).inputs ?? []) as Bound[];
  const root = inputs.find((i) => i.slot === 'map')?.model?.nodes?.[0]?.text ?? '';
  const sources: unknown[] = [];
  for (const m of root.matchAll(/需求\s*(\d+)/g)) sources.push({ external: `toy:story:${m[1]}`, role: 'expected', reason: `标题里关联的需求 ${m[1]}` });
  sources.push({ external: 'toy:manual:zone', role: 'expected', reason: '分区命令手册' });
  sources.push({ external: 'toy:history:zone-list', role: 'hint', reason: '相似功能的历史用例清单' });
  sources.push({ external: 'toy:broken:offline', role: 'expected', reason: '一个读不到的来源' });
  return { sources, warnings: [] };
}
