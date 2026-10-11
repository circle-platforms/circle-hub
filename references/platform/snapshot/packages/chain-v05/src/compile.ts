import type { TopicNode } from "./ir.js";

/** One row of the frozen `用例清单` sheet (Excel contract §3.2). */
export interface WorkbookRow {
  /** 编号: TC-001 ... in depth-first order. */
  id: string;
  /** 一级模块: path segment 1. */
  level1: string;
  /** 二级模块: path segment 2 (the node's own title at depth 2). */
  level2: string;
  /** 用例标题 */
  title: string;
  /** 备注 (empty string, never a placeholder). */
  note: string;
  /** 层级深度 (root = 0), a numeric cell. */
  depth: number;
  /** 路径: titles below the root joined with `/`. */
  path: string;
}

/**
 * Row rule (§3.2): the root and depth-1 module nodes are groupings only;
 * every topic at depth >= 2 is exactly one row, depth-first.
 */
export function compileRows(root: TopicNode): WorkbookRow[] {
  const rows: WorkbookRow[] = [];
  let seq = 0;
  const walk = (node: TopicNode, depth: number, segments: string[]) => {
    const here = depth === 0 ? segments : [...segments, node.title];
    if (depth >= 2) {
      seq += 1;
      rows.push({
        id: `TC-${String(seq).padStart(3, "0")}`,
        level1: here[0] ?? "",
        level2: here[1] ?? "",
        title: node.title,
        note: node.note ?? "",
        depth,
        path: here.join("/"),
      });
    }
    for (const child of node.children) walk(child, depth + 1, here);
  };
  walk(root, 0, []);
  return rows;
}
