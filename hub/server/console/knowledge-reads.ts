// Knowledge node reads for the tree page (K4; U5 retired the JSON twin).
import type { NodeViews } from '../../ports.ts';
import type { PageContext } from './context.ts';

type NodeView = NodeViews[number];

/** One node at `path` under `root`, or null when absent or unreadable. */
export async function loadKnowledgeNode(ctx: PageContext, root: string, path: string): Promise<NodeView | null> {
  const page = await ctx.deps.knowledge.getNodes({ root, paths: [path], depth: 0 }, ctx.principal);
  return page?.nodes.find((candidate) => candidate.path === path) ?? null;
}

/** Children listing under `path` (depth 1), same call the tree page and the nodes API use. */
export async function loadKnowledgeNodes(
  ctx: PageContext,
  root: string,
  path: string,
  cursor: string | null,
): Promise<Awaited<ReturnType<PageContext['deps']['knowledge']['getNodes']>>> {
  return ctx.deps.knowledge.getNodes({ root, paths: [path], depth: 1, cursor }, ctx.principal);
}
