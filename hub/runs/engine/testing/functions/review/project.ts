// Synthetic pack function (toy-review): KityMinder-like mind map -> items. A case is a node with a non-empty `resource` array;
// its children are its expected results; a `negative` tag marks a negative case; a `cli` field holds its command phrase.
// Self-contained: the sandbox lets a pack function import only modules inside its pack.

interface Node {
  id: string | null;
  text: string;
  data: Record<string, unknown>;
  children: number[];
  parent: number | null;
  selector: string;
}

interface Bound {
  slot: string;
  parser: string;
  model: { nodes?: Node[] } | null;
  meta: Record<string, unknown> | null;
}

export default function project(input: unknown): unknown {
  const inputs = ((input as { inputs?: Bound[] }).inputs ?? []) as Bound[];
  const subject = inputs.find((i) => i.slot === 'map');
  if (subject === undefined || subject.parser !== 'kityminder@1' || subject.model === null || !Array.isArray(subject.model.nodes)) {
    return { error: { code: 'toy-review.invalid_input', message: '被判对象不是脑图', fix: '上传 KityMinder 脑图' }, warnings: [] };
  }
  const nodes = subject.model.nodes;
  const document = typeof subject.meta?.document === 'string' ? subject.meta.document : (nodes[0]?.id ?? 'doc');
  const items: unknown[] = [];
  const groups: unknown[] = [];
  nodes.forEach((node, index) => {
    const resource = node.data.resource;
    if (!Array.isArray(resource) || resource.length === 0) {
      if (index > 0 && node.data.priority !== undefined) groups.push({ id: node.id, text: node.text });
      return;
    }
    const path: string[] = [];
    for (let p = node.parent; p !== null; p = nodes[p].parent) path.unshift(nodes[p].text);
    const tags = resource.filter((t): t is string => typeof t === 'string');
    items.push({
      id: `${document}:${node.id ?? `@${index}`}`,
      label: node.text,
      summary: `优先级 ${String(node.data.priority ?? '无')}，${node.children.length} 个期望结果`,
      location: { parser: 'kityminder@1', selector: node.selector },
      fields: {
        document,
        path,
        title: node.text,
        priority: typeof node.data.priority === 'number' ? node.data.priority : null,
        tags,
        expected: node.children.map((c) => nodes[c].text),
        negative: tags.includes('negative'),
        commands: typeof node.data.cli === 'string' ? [node.data.cli] : [],
      },
    });
  });
  if (items.length === 0) return { error: { code: 'toy-review.no_case', message: '文档里没有用例节点', fix: '给用例节点加上 resource 标签', documents: [document] }, warnings: [] };
  return { items, groups, warnings: [] };
}
