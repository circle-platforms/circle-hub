// Synthetic system pack (tests only): planner of agile:mindmap:<document>. Round 1 reads the document and asks for the trees
// of the configured roots (input.settings.roots) as nested reads, which the Hub serves from its cache; round 2 refreshes the
// cached trees once when none of them holds the document (it may have been added after they were read).
type Nested = { ok: boolean; cached: boolean; content: unknown };
type Input = { round: number; external: { key: string }; settings: { roots?: unknown }; reads: Record<string, Nested> };

type TreeNode = { id?: unknown; children?: unknown };

function holds(nodes: unknown, id: string, depth = 0): boolean {
  if (!Array.isArray(nodes) || depth > 64) return false;
  return (nodes as TreeNode[]).some((node) => String(node?.id) === id || holds(node?.children, id, depth + 1));
}

export default function (input: unknown): unknown {
  const { round, external, settings, reads } = input as Input;
  const roots = Array.isArray(settings.roots) ? settings.roots.map(String) : [];
  const tree = (root: string) => `agile:tree:${root}`;
  if (round === 1) return { requests: [{ key: 'case', route: 'case-data', body: { id: external.key } }], reads: roots.map((root) => ({ external: tree(root) })), done: false };
  const found = roots.some((root) => holds((reads[tree(root)]?.content as { children?: unknown } | null)?.children, external.key));
  const stale = roots.filter((root) => reads[tree(root)]?.cached === true);
  if (found || stale.length === 0) return { requests: [], done: true };
  return { requests: [], reads: stale.map((root) => ({ external: tree(root), refresh: true })), done: true };
}
