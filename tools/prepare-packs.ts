// Prepare repository packages with their owning generators; never publish or choose a version for the author.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_DIRECTORIES } from '../packs/workflow/case-review/packaging.ts';
import { canonicalJson } from '../hub/refs/api.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export type Preparation = { id: string; directory: string; script: string; args: string[] };

/** Directories come from Git paths, never from product names or document text. */
export function packsOfPaths(paths: readonly string[]): string[] {
  const packs = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts[0] === 'packs' && parts.length >= 4 && parts[1] && parts[2]) packs.add(parts.slice(0, 3).join('/'));
  }
  return [...packs].sort();
}

/** Resolve every owner before invoking any of them, so an invalid list cannot partially prepare packages. */
export function preparationPlan(paths: readonly string[], root = ROOT, shared = PACK_DIRECTORIES): Preparation[] {
  const repo = realpathSync(root), result: Preparation[] = [], seen = new Set<string>();
  for (const input of paths) {
    const path = realpathSync(isAbsolute(input) ? input : resolve(repo, input));
    const parts = relative(repo, path).split(sep);
    if (parts.length !== 3 || parts[0] !== 'packs' || parts.some(part => part === '..' || part === '')) throw new Error('请明确给出仓库 packs 下的包目录');
    const manifest = JSON.parse(readFileSync(resolve(path, 'pack.json'), 'utf8')) as { id?: unknown };
    if (typeof manifest.id !== 'string' || manifest.id !== parts[2]) throw new Error('包目录和 pack.json 的 id 不一致');
    if (seen.has(path)) continue;
    seen.add(path);
    const own = resolve(path, 'pack-files.ts'), api = resolve(path, 'api.ts');
    if (existsSync(own)) result.push({ id: manifest.id, directory: path, script: own, args: ['--write'] });
    else if (existsSync(api)) result.push({ id: manifest.id, directory: path, script: api, args: ['sign'] });
    else if (shared[manifest.id] && realpathSync(shared[manifest.id]) === path) result.push({ id: manifest.id, directory: path, script: resolve(repo, 'packs/workflow/case-review/packaging.ts'), args: ['sign', manifest.id] });
    else throw new Error(`包 ${manifest.id} 没有声明可用的清单生成工具`);
  }
  return result;
}

function git(args: string[], root: string): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('读取 Git 基线失败；核对提交与工作树');
  return result.stdout;
}

export function changedPacks(base: string, root = ROOT): string[] {
  git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], root);
  // Report a moved file as deletion plus addition so both pack manifests get refreshed.
  const changed = git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', base, '--', 'packs/'], root);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'packs/'], root);
  return packsOfPaths((changed + untracked).split('\0').filter(Boolean));
}

export function versionWarning(before: string | null, after: string): boolean {
  if (before === null) return false;
  const old = JSON.parse(before) as { version?: unknown }, next = JSON.parse(after) as { version?: unknown };
  return old.version === next.version && canonicalJson(old) !== canonicalJson(next);
}

export function preparePacks(paths: readonly string[], options: { root?: string; base?: string; shared?: Readonly<Record<string, string>> } = {}): void {
  const root = options.root ?? ROOT, plan = preparationPlan(paths, root, options.shared);
  for (const pack of plan) {
    const previous = options.base === undefined ? null : (() => {
      const path = relative(root, resolve(pack.directory, 'pack.json')).split(sep).join('/');
      const result = spawnSync('git', ['show', `${options.base}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return result.status === 0 ? result.stdout : null;
    })();
    const result = spawnSync(process.execPath, [pack.script, ...pack.args], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`包 ${pack.id} 的生成工具未完成；先修正后重跑`);
    const current = readFileSync(resolve(pack.directory, 'pack.json'), 'utf8');
    if (versionWarning(previous, current)) console.error(`注意：${pack.id} 的内容改变但版本与基线相同；已发布过时须先升版再重新生成`);
  }
}

function main(args: string[]): void {
  if (args[0] === '--changed' && args.length === 2) {
    const packs = changedPacks(args[1]);
    if (!packs.length) return void console.log('没有改动的包');
    preparePacks(packs, { base: args[1] });
  } else if (args.length && args.every(arg => !arg.startsWith('-'))) preparePacks(args);
  else throw new Error('用法：node tools/prepare-packs.ts <包目录>… | --changed <基线提交>');
}

if (import.meta.main) try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : '清单准备未完成'); process.exitCode = 1; }
