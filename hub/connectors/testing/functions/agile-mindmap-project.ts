// Synthetic system pack (tests only): projection of agile:mindmap:<document>: `content` is the inner KityMinder document
// exactly as it was inside the double-encoded data string; `meta` is the document title and the labels of the folders above
// it, from the root down, found in the trees of the configured roots.
type Response = { ok: boolean; json?: unknown };
type Nested = { ok: boolean; content: unknown };
type Input = { external: { key: string }; settings: { roots?: unknown }; responses: Record<string, Response>; reads: Record<string, Nested>; original: string };
type TreeNode = { id?: unknown; label?: unknown; children?: unknown };

function path(nodes: unknown, id: string, above: string[], depth = 0): { title: string; folders: string[] } | null {
  if (!Array.isArray(nodes) || depth > 64) return null;
  for (const node of nodes as TreeNode[]) {
    const label = typeof node?.label === 'string' ? node.label : '';
    if (String(node?.id) === id) return { title: label, folders: above };
    const found = path(node?.children, id, [...above, label], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export default function (input: unknown): unknown {
  const { external, settings, responses, reads, original } = input as Input;
  const data = (responses[original]?.json as { data?: unknown } | undefined)?.data;
  if (typeof data !== 'string') return { error: { code: 'agile-test.not_encoded', message: '用例数据不是字符串' } };
  const roots = Array.isArray(settings.roots) ? settings.roots.map(String) : [];
  let found: { title: string; folders: string[] } | null = null;
  for (const root of roots) {
    const tree = reads[`agile:tree:${root}`]?.content as { root?: { label?: unknown }; children?: unknown } | null | undefined;
    if (!tree) continue;
    const top = typeof tree.root?.label === 'string' ? [tree.root.label] : [];
    found = path(tree.children, external.key, top);
    if (found !== null) break;
  }
  return {
    artifacts: [
      { name: 'content', media_type: 'application/json', text: data },
      { name: 'meta', media_type: 'application/json', json: { title: found?.title ?? null, folders: found?.folders ?? [], found: found !== null } },
    ],
    ...(found === null ? { note: '配置的根里没有这份文档' } : {}),
  };
}
