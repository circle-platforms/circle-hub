import { join } from 'node:path';
import { listFiles, sha256File } from '../../platform/api.ts';
import type { Layout } from '../../platform/api.ts';

export interface ProtectedFile { area: 'keys' | 'vault'; path: string; size: number; sha256: string; }
export async function protectedFiles(layout: Layout): Promise<ProtectedFile[]> {
  const out: ProtectedFile[] = [];
  for (const area of ['keys', 'vault'] as const) {
    const root = join(layout.root, area);
    for (const path of await listFiles(root)) out.push({ area, path, ...await sha256File(join(root, path)) });
  }
  return out.sort((a, b) => a.area.localeCompare(b.area) || a.path.localeCompare(b.path));
}
export async function assertProtectedFiles(layout: Layout, before: readonly ProtectedFile[]): Promise<void> {
  const after = await protectedFiles(layout);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('密钥文件或密钥库文件清单及字节身份发生变化，不能报告重建成功');
}
