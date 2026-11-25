import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function makeSkills(versions: Record<string, string>, plumb = true) {
  const root = await mkdtemp(join(tmpdir(), 'open-compile-skills-'));
  for (const [pack, version] of Object.entries(versions)) { await mkdir(join(root, pack), { recursive: true }); await writeFile(join(root, pack, 'pack.json'), JSON.stringify({ id: pack, version })); }
  if (plumb) { await mkdir(join(root, 'plumb', 'tools'), { recursive: true }); await writeFile(join(root, 'plumb', 'tools', 'plumb.ts'), ''); }
  return root;
}
