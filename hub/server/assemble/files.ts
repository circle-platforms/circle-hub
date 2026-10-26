// Removing a temporary directory that holds extracted packs: the registry extracts them read-only (directories 0500,
// files 0400), so every directory is made writable again before the tree is removed. Links are never followed.
import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function removeTree(root: string): Promise<void> {
  const unlock = async (path: string): Promise<void> => {
    let info;
    try {
      info = await lstat(path);
    } catch {
      return;
    }
    if (!info.isDirectory()) return;
    await chmod(path, 0o700).catch(() => {});
    for (const name of await readdir(path).catch(() => [] as string[])) await unlock(join(path, name));
  };
  await unlock(root);
  await rm(root, { recursive: true, force: true, maxRetries: 2 });
}
