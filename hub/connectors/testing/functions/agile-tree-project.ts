// Synthetic system pack (tests only): projection of agile:tree:<root>: content is {root: {id, label}, children} with the
// subtree as answered; meta holds the root label. A root missing from the listing leaves its label null (incomplete).
type Response = { ok: boolean; json?: unknown };
type Input = { external: { key: string }; responses: Record<string, Response>; original: string };

export default function (input: unknown): unknown {
  const { external, responses, original } = input as Input;
  const subtree = (responses[original]?.json as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(subtree)) return { error: { code: 'agile-test.no_subtree', message: '子树应答里没有数组' } };
  let label: string | null = null;
  for (const [key, response] of Object.entries(responses)) {
    if (!key.startsWith('page-')) continue;
    const list = (response.json as { data?: { list?: unknown } } | undefined)?.data?.list;
    if (!Array.isArray(list)) continue;
    for (const root of list as { id: unknown; label: unknown }[]) if (String(root.id) === external.key && typeof root.label === 'string') label = root.label;
  }
  return {
    artifacts: [
      { name: 'content', media_type: 'application/json', json: { root: { id: external.key, label }, children: subtree } },
      { name: 'meta', media_type: 'application/json', json: { label } },
    ],
    ...(label === null ? { complete: false, note: '根列表里没有这个根' } : {}),
  };
}
