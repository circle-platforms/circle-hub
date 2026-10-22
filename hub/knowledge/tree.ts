// In-memory tree of one production: entries are hung on paths, then digests are computed bottom-up (K01 R[1], R[2]).
// Nothing here touches the database; store.ts writes the result and shares nodes that already exist.
import type { NodeLevel } from '../../contracts/generated/vocabulary.ts';
import { levelOfHeight, type TreeNodeChild } from '../../contracts/src/knowledge.ts';
import { pathOf } from '../refs/api.ts';
import { compareText, nodeDigest } from './digest.ts';

/** Deepest path the tree accepts: a reference path holds at most 256 segments (hub/refs MAX_SEGMENTS). */
export const MAX_TREE_DEPTH = 256;

export interface MutableNode {
  name: string;
  children: Map<string, MutableNode>;
  entries: Set<string>;
}

/** A node with its digest, as written to a tree_node@1 record. */
export interface BuiltNode {
  /** Decoded segments from the root. */
  segments: string[];
  /** Canonical path text. */
  path: string;
  name: string;
  digest: string;
  height: number;
  level: NodeLevel;
  children: TreeNodeChild[];
  entries: string[];
  /** Built children in name order. */
  built: BuiltNode[];
}

function newNode(name: string): MutableNode {
  return { name, children: new Map(), entries: new Set() };
}

export class TreeBuilder {
  readonly root: MutableNode = newNode('');
  /** Most entries one node holds (a node record stays bounded). */
  readonly maxEntries: number;

  constructor(maxEntries = Number.POSITIVE_INFINITY) {
    this.maxEntries = maxEntries;
  }

  /**
   * Hangs an entry on the node at `segments`, creating the nodes on the way. False (and nothing created) when that node
   * already holds `maxEntries` other entries.
   */
  add(segments: readonly string[], entry: string): boolean {
    if (segments.length > MAX_TREE_DEPTH) throw new RangeError(`a tree path has at most ${MAX_TREE_DEPTH} segments`);
    const found = this.find(segments);
    if (found !== null && !found.entries.has(entry) && found.entries.size >= this.maxEntries) return false;
    let node = this.root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = newNode(segment);
        node.children.set(segment, child);
      }
      node = child;
    }
    node.entries.add(entry);
    return true;
  }

  /** The node at `segments`, or null. */
  find(segments: readonly string[]): MutableNode | null {
    let node: MutableNode | undefined = this.root;
    for (const segment of segments) {
      node = node.children.get(segment);
      if (node === undefined) return null;
    }
    return node;
  }

  /** Builds digests bottom-up. The tree is not changed. */
  build(): BuiltNode {
    return buildNode(this.root, []);
  }
}

function buildNode(node: MutableNode, segments: string[]): BuiltNode {
  const names = [...node.children.keys()].sort(compareText);
  const built = names.map((name) => buildNode(node.children.get(name) as MutableNode, [...segments, name]));
  const children = built.map((child) => ({ name: child.name, digest: child.digest }));
  const entries = [...node.entries].sort(compareText);
  const height = built.reduce((highest, child) => Math.max(highest, child.height + 1), 0);
  return {
    segments,
    path: pathOf(segments),
    name: node.name,
    digest: nodeDigest({ name: node.name, children, entries }),
    height,
    level: levelOfHeight(height),
    children,
    entries,
    built,
  };
}

/** Every built node in pre-order. */
export function flatten(root: BuiltNode): BuiltNode[] {
  const out: BuiltNode[] = [];
  const stack: BuiltNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as BuiltNode;
    out.push(node);
    for (let i = node.built.length - 1; i >= 0; i--) stack.push(node.built[i]);
  }
  return out;
}
