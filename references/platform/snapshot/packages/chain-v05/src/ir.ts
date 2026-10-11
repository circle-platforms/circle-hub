import { createHash } from "node:crypto";

/**
 * The frozen intermediate representation (Excel contract §1): a topic
 * tree. Compilation only ever goes input -> IR -> workbook.
 */
export interface TopicNode {
  title: string;
  note?: string;
  children: TopicNode[];
}

/** An input element that could not be mapped; never silently dropped (§3.5). */
export interface UnmappedEntry {
  path: string;
  reason: string;
}

/** Title normalization (§1): trim, internal newlines become single spaces. */
export function normalizeTitle(raw: string): string {
  return raw.trim().replace(/\r\n/g, "\n").replace(/\n/g, " ");
}

function canonical(node: TopicNode): unknown {
  return {
    title: node.title,
    ...(node.note !== undefined ? { note: node.note } : {}),
    children: node.children.map(canonical),
  };
}

/** SHA-256 of the canonical IR serialization (§1). */
export function irHash(root: TopicNode): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(root)))
    .digest("hex");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
