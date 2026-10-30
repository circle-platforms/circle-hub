import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
export class Refusal extends Error { code: number; constructor(message: string, code = 1) { super(message); this.code = code; } }
export function need(ok: unknown, message: string): asserts ok { if (!ok) throw new Refusal(message); }
export const cut = (text: string, n: number): string => Array.from(text).slice(0, n).join('');
export function secureUrl(value: string, model?: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Refusal('地址格式不对；填写 HTTPS 地址，本机回环可用 HTTP'); }
  const h = url.hostname; const loopback = h === 'localhost' || h === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(h);
  need(url.username === '' && url.password === '' && url.search === '' && url.hash === '' && (url.protocol === 'https:' || url.protocol === 'http:' && loopback), '地址必须用 HTTPS；明文 HTTP 只许本机回环，地址不带凭据、查询或片段');
  need(!model?.includes('scripted') || loopback, 'scripted 模型只能连本机回环；改用回环假服务或确切的服务模型版本');
  if (h === 'localhost') url.hostname = '127.0.0.1'; return url;
}
export function secretGuard(secrets: readonly string[]): (value: unknown) => void {
  const runs = secrets.flatMap((secret) => secret.length < 12 ? [secret] : Array.from({ length: secret.length - 11 }, (_, i) => secret.slice(i, i + 12)));
  return (value) => { const text = typeof value === 'string' ? value : JSON.stringify(value); need(!runs.some((run) => text.includes(run)), '输入或应答出现凭据，整份丢弃；所有者核查源资料和服务端后重跑'); };
}
export async function readKeys(input: AsyncIterable<Uint8Array | string>, jev: boolean) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length; need(size <= 9000, '标准输入太长；仅输入所需密钥行'); chunks.push(bytes); }
  const all = Buffer.concat(chunks); let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { throw new Refusal('标准输入不是 UTF-8；所有者重新提供密钥'); } finally { all.fill(0); chunks.forEach((b) => b.fill(0)); }
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/); need(lines.length === (jev ? 2 : 1), '密钥行数不对；Jev 命令两行，lock/submit 只有 Hub 令牌一行');
  const valid = (key: string, name: string) => { need(key.length >= 1 && key.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(key), `缺少有效 ${name}；所有者用 /secrets ${name} 存好后重跑`); return key; };
  return { jev: jev ? valid(lines[0]!, 'JEV_API_KEY') : '', hub: valid(lines[jev ? 1 : 0]!, 'HUB_TOKEN') };
}
export class LocalStore {
  directory: string; guard: (value: unknown) => void;
  constructor(directory: string, guard: (value: unknown) => void) { this.directory = directory; this.guard = guard; }
  static async open(path: string, cwd: string, guard: (value: unknown) => void) {
    need(!isAbsolute(path) && path !== '', '--out 必须是工作目录里的文件夹；用相对目录'); const target = resolve(cwd, path); const root = await realpath(cwd);
    const rel = relative(resolve(cwd), target); need(rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel), '--out 必须在当前工作目录内');
    let current = resolve(cwd); for (const part of rel.split(sep)) { current = resolve(current, part); const stat = await lstat(current).catch(() => null); need(!stat || stat.isDirectory() && !stat.isSymbolicLink(), '输出目录含链接或非目录；换一个工作目录内的普通文件夹'); }
    await mkdir(target, { recursive: true, mode: 0o700 }); need((await realpath(target)).startsWith(root + sep), '输出目录不在工作目录；选择普通子目录'); return new LocalStore(target, guard);
  }
  async append(name: string, value: unknown) { this.guard(value); const file = resolve(this.directory, name); const stat = await lstat(file).catch(() => null); need(!stat || stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, '记录文件含链接；换普通输出目录'); await appendFile(file, JSON.stringify(value) + '\n', { mode: 0o600 }); }
  async write(name: string, value: unknown, replace = false) {
    this.guard(value); const file=resolve(this.directory,name);need(file.startsWith(this.directory+sep),'输出文件不能离开结果目录');
    const rel=relative(this.directory,resolve(file,'..'));let parent=this.directory;
    for(const part of rel.split(sep).filter(Boolean)){parent=resolve(parent,part);const stat=await lstat(parent).catch(()=>null);need(!stat||stat.isDirectory()&&!stat.isSymbolicLink(),'结果目录不能含链接');if(!stat)await mkdir(parent,{mode:0o700});}
    const bytes=JSON.stringify(value,null,2)+'\n';const stat=await lstat(file).catch(()=>null);if(stat){need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'结果文件不能含链接');if(await readFile(file,'utf8')===bytes)return;need(replace,'已有回执不覆盖；使用新的输出目录或查看已有回执');}
    if(!replace)await writeFile(file,bytes,{mode:0o600,flag:'wx'});else{const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes,{mode:0o600,flag:'wx'});await rename(temp,file);}
  }
  async records(name: string): Promise<any[]> { const file = resolve(this.directory, name); const stat = await lstat(file).catch(() => null); if (!stat) return []; need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, '记录文件不能是链接；核对输出目录'); const text = await readFile(file, 'utf8'); this.guard(text); return text.trim() === '' ? [] : text.trimEnd().split('\n').map((line) => JSON.parse(line)); }
}

export async function readJsonFile(name:string,cwd:string,guard:(value:unknown)=>void){
 let raw:string;try{raw=await readFile(resolve(cwd,name),'utf8');}catch(error){const code=(error as NodeJS.ErrnoException).code??'UNKNOWN';throw new Refusal(`${name}：读取失败（${code}）；补齐可读文件后重跑`);}
 guard(raw);try{return JSON.parse(raw);}catch(error){throw new Refusal(`${name}：JSON 格式不对（${(error as Error).message}）；修正该文件后重跑`);}
}
