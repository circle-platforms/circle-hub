// Guard-only maintenance. Never reads environment files, credentials, secrets or session stores.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export type GuardBundle = Record<string, string>;
interface Receipt { schema: 'guard-installation@1'; profile: 'skills' | 'ops'; files: Record<string, string>; skills: Record<string, string> }
export const RECEIPT = 'hooks/guard-installation.json';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function regular(home: string, rel: string): Buffer {
  let current = home;
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error('Home 必须是普通目录');
  for (const part of rel.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接：${rel}`);
  }
  if (!lstatSync(current).isFile()) throw new Error(`不是普通文件：${rel}`);
  return readFileSync(current);
}

function skillHashes(home: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (rel: string) => {
    const dir = join(home, rel);
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error(`技能目录无效：${rel}`);
    for (const name of readdirSync(dir).sort()) {
      const file = `${rel}/${name}`;
      const stat = lstatSync(join(home, file));
      if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接：${file}`);
      if (stat.isDirectory()) walk(file);
      else result[file] = hash(regular(home, file));
    }
  };
  walk('skills');
  return result;
}

const same = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

export function bundleHashes(bundle: GuardBundle): Record<string, string> {
  return Object.fromEntries(Object.entries(bundle).map(([file, content]) => [file, hash(content)]));
}

function write(home: string, rel: string, content: string): void {
  // Reject symlinked parents and destinations before replacing a managed file.
  const parts = rel.split('/');
  let parent = home;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error(`目录无效：${rel}`);
  }
  const temp = join(parent, `.${parts.at(-1)}.${process.pid}.tmp`);
  writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
  renameSync(temp, join(home, rel));
  chmodSync(join(home, rel), 0o600);
}

export function recordInstallation(home: string, profile: Receipt['profile'], bundle: GuardBundle): void {
  const receipt: Receipt = { schema: 'guard-installation@1', profile, files: bundleHashes(bundle), skills: skillHashes(home) };
  write(home, RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
}

export function maintainInstallation(
  home: string, profile: Receipt['profile'], bundle: GuardBundle, allowed: string,
  mode: 'verify' | 'update', baseline?: string,
): void {
  const expected = bundleHashes(bundle);
  // A caller-provided baseline is an operator-reviewed manifest, never a snapshot silently adopted from the target.
  const raw = baseline === undefined ? regular(home, RECEIPT).toString() : readFileSync(baseline, 'utf8');
  let prior: Receipt;
  try { prior = JSON.parse(raw) as Receipt; } catch { throw new Error('安装回执不是有效 JSON，请核对集成者提供的原版本回执'); }
  if (!prior || prior.schema !== 'guard-installation@1' || prior.profile !== profile || !prior.files || !prior.skills ||
      !same(Object.fromEntries(Object.keys(expected).map(key => [key, ''])), Object.fromEntries(Object.keys(prior.files).map(key => [key, ''])))) {
    throw new Error('安装回执与目标配置不匹配；旧 Home 需要集成者提供已审查的原版本回执 --baseline');
  }
  const actual = Object.fromEntries(Object.keys(expected).map(file => [file, hash(regular(home, file))]));
  const changed = Object.keys(expected).filter(file => actual[file] !== prior.files[file]);
  if (changed.length) throw new Error(`守卫文件与原安装回执不同，未覆盖：${changed.join('、')}`);
  const skills = skillHashes(home);
  if (mode === 'verify') {
    if (!same(actual, expected)) throw new Error('守卫版本与当前源码不同；请集成者停止会话后运行 guard update');
    if (!same(skills, prior.skills)) throw new Error('技能安装已变化；请先核验包摘要，再运行 guard update');
    if (regular(home, 'hooks/ALLOWED.md').toString() !== allowed) throw new Error('规则全文需要重新生成；请运行 guard update');
    return;
  }
  // Validate all inputs before writing. A partial update leaves the old receipt and fails verification.
  for (const [file, content] of Object.entries(bundle)) write(home, file, content);
  write(home, 'hooks/ALLOWED.md', allowed);
  recordInstallation(home, profile, bundle);
}
