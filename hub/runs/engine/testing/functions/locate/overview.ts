// Synthetic pack check function (toy-locate): one run-level fact over all items, without an item: how many cases per group.

interface Item {
  fields?: { path?: string[] };
}

export default function overview(input: unknown): unknown {
  const items = ((input as { subject?: { items?: Item[] } }).subject?.items ?? []) as Item[];
  const groups: Record<string, number> = {};
  for (const it of items) {
    const path = it.fields?.path ?? [];
    const group = path[path.length - 1] ?? '';
    groups[group] = (groups[group] ?? 0) + 1;
  }
  return [{ verdict: 'support', statement: `共 ${items.length} 个用例`, grounds: [], tier: 'advisory', data: { cases: items.length, groups } }];
}
