import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function stageRecompose(folder: string, target: string) { const source = fileURLToPath(new URL('../' + folder + '/', import.meta.url)), manifest = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8')); for (const path of ['pack.json', ...manifest.files.map((f: any) => f.path)]) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await copyFile(join(source, path), join(target, path));
} return target; }
