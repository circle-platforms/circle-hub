import { SpaceTreeNode } from '../../../contracts/src/spaces.ts';
import { canonicalize, sha256Hex } from '../../records/api.ts';
import { pathOf, pathSegments } from '../../refs/api.ts';
import { fields, type OldRecord, type UpgradeIssue } from './state.ts';

/** Space objects have typed child edges; declared product mounts switch to the separate product-record graph. */
export async function expandSpaceObjectGraph(records: readonly OldRecord[], selected: ReadonlySet<string>, objects: Set<string>, read: (hash: string) => Promise<Uint8Array | null>): Promise<UpgradeIssue[]> {
  const pending: Array<{ hash: string; row: number; path: string; mounts: Map<string, string> }> = [];
  records.forEach((record, index) => {
    if (selected.has(record.digest) && record.schema === 'knowledge-space-version@1') {
      const body = fields(record.body), tree = body.tree;
      const products = body.products as Array<{ path: string; root: string }> | undefined;
      const mounts = new Map((products ?? []).map(product => [product.path, product.root]));
      if (typeof tree === 'string') pending.push({ hash: tree, row: index + 1, path: '/', mounts });
    }
  });
  const visited = new Set<string>(), nodes = new Map<string, SpaceTreeNode>(), issues: UpgradeIssue[] = [];
  for (let index = 0; index < pending.length; index++) {
    const { hash, row, path, mounts } = pending[index]!;
    const key = row + ':' + path;
    if (visited.has(key)) continue;
    visited.add(key);
    try {
      const mount = mounts.get(path);
      if (mount !== undefined) {
        if (hash !== mount) throw new Error();
        // selectState already checks products[].root through the product-record aliases.
        continue;
      }
      let node = nodes.get(hash);
      if (!node) {
        const bytes = await read(hash);
        if (!bytes || sha256Hex(bytes) !== hash) throw new Error();
        const text = Buffer.from(bytes).toString('utf8');
        node = SpaceTreeNode.parse(JSON.parse(text));
        if (canonicalize(node) !== text) throw new Error();
        nodes.set(hash, node);
      }
      objects.add(hash);
      for (const child of node.children) pending.push({ hash: child.digest, row, path: pathOf([...pathSegments(path), child.name]), mounts });
    } catch { issues.push({ table: 'space_objects', row, reason: '知识空间子树对象缺失、摘要不符或不合正式节点模式' }); }
  }
  return issues;
}
