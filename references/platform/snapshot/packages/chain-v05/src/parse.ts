import { normalizeTitle, type TopicNode, type UnmappedEntry } from "./ir.js";

export interface ParseOutcome {
  root?: TopicNode;
  unmapped: UnmappedEntry[];
  /** Set when the input cannot yield an IR at all (§3.5: overall failure). */
  failure?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/* Topic-tree JSON: a bare IR node, or an object carrying `root`.      */
/* ------------------------------------------------------------------ */

function convertTreeNode(
  raw: unknown,
  path: string,
  unmapped: UnmappedEntry[],
  isRoot: boolean,
): TopicNode | undefined {
  if (!isObject(raw)) {
    unmapped.push({ path, reason: "topic is not an object" });
    return undefined;
  }
  if (typeof raw.title !== "string") {
    unmapped.push({ path, reason: "topic title is missing or not a string" });
    return undefined;
  }
  const title = normalizeTitle(raw.title);
  if (title.length === 0) {
    unmapped.push({ path, reason: "topic title is empty after normalization" });
    return undefined;
  }
  const node: TopicNode = { title, children: [] };
  if (raw.note !== undefined) {
    if (typeof raw.note === "string") node.note = raw.note;
    else unmapped.push({ path, reason: "note is not a string; dropped" });
  }
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) {
      unmapped.push({ path, reason: "children is not an array; dropped" });
    } else {
      raw.children.forEach((child, i) => {
        const converted = convertTreeNode(
          child,
          `${path}/children[${i}]`,
          unmapped,
          false,
        );
        if (converted) node.children.push(converted);
      });
    }
  }
  void isRoot;
  return node;
}

export function parseTopicTree(data: unknown): ParseOutcome {
  const unmapped: UnmappedEntry[] = [];
  const candidate = isObject(data) && isObject(data.root) ? data.root : data;
  const root = convertTreeNode(candidate, "$", unmapped, true);
  if (!root) {
    return {
      unmapped,
      failure: "topic-tree root is not a valid topic (see unmapped entries)",
    };
  }
  return { root, unmapped };
}

/* ------------------------------------------------------------------ */
/* XMind content.json: sheets -> rootTopic -> children.attached,       */
/* notes from notes.plain.content (contract §2). Multi-sheet input is  */
/* out of the frozen scope: extra sheets are reported unmapped (§5).   */
/* ------------------------------------------------------------------ */

const KNOWN_TOPIC_KEYS = new Set(["id", "title", "notes", "children"]);

function convertXmindTopic(
  raw: unknown,
  path: string,
  unmapped: UnmappedEntry[],
): TopicNode | undefined {
  if (!isObject(raw)) {
    unmapped.push({ path, reason: "topic is not an object" });
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOPIC_KEYS.has(key)) {
      unmapped.push({ path, reason: `unknown topic property ignored: ${key}` });
    }
  }
  if (typeof raw.title !== "string") {
    unmapped.push({ path, reason: "topic title is missing or not a string" });
    return undefined;
  }
  const title = normalizeTitle(raw.title);
  if (title.length === 0) {
    unmapped.push({ path, reason: "topic title is empty after normalization" });
    return undefined;
  }
  const node: TopicNode = { title, children: [] };
  if (isObject(raw.notes) && isObject(raw.notes.plain)) {
    const content = raw.notes.plain.content;
    if (typeof content === "string") node.note = content;
    else if (content !== undefined) {
      unmapped.push({ path, reason: "notes.plain.content is not a string; dropped" });
    }
  }
  if (isObject(raw.children)) {
    for (const key of Object.keys(raw.children)) {
      if (key !== "attached") {
        unmapped.push({
          path,
          reason: `children.${key} is not mapped by the frozen contract`,
        });
      }
    }
    const attached = raw.children.attached;
    if (Array.isArray(attached)) {
      attached.forEach((child, i) => {
        const converted = convertXmindTopic(
          child,
          `${path}/attached[${i}]`,
          unmapped,
        );
        if (converted) node.children.push(converted);
      });
    }
  }
  return node;
}

export function parseXmindContent(data: unknown): ParseOutcome {
  const unmapped: UnmappedEntry[] = [];
  if (!Array.isArray(data) || data.length === 0) {
    return { unmapped, failure: "content.json must be a non-empty array of sheets" };
  }
  data.forEach((sheet, i) => {
    if (i > 0) {
      unmapped.push({
        path: `$[${i}]`,
        reason: "additional sheets are not compiled (multi-sheet deferred, contract §5)",
      });
    }
    void sheet;
  });
  const first: unknown = data[0];
  if (!isObject(first) || !isObject(first.rootTopic)) {
    return { unmapped, failure: "first sheet has no rootTopic object" };
  }
  const root = convertXmindTopic(first.rootTopic, "$[0].rootTopic", unmapped);
  if (!root) {
    return { unmapped, failure: "rootTopic is not a valid topic (see unmapped entries)" };
  }
  return { root, unmapped };
}
