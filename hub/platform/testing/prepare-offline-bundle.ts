// Independent unprivileged cache preparation. Only fixed public-registry tarballs are fetched; no install script runs.
import {createHash,randomBytes} from 'node:crypto';
import {cp,lstat,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runCommand} from '../process.ts';
import type {Stats} from 'node:fs';
import {requireSyntheticVm} from './linux-real-vm.ts';
import {sealPreparedOfflineBundle,parseMountInfo,trustedRootMount,sourceMountReceipt,type MountRow} from './linux-rehearsal-isolation.ts';

export function publicLockedTarballs(lock:unknown):{url:string;integrity:string}[]{
 if(!lock||typeof lock!=='object'||(lock as {lockfileVersion?:unknown}).lockfileVersion!==3)throw new Error('需要固定的lockfileVersion 3');
 const packages=(lock as {packages?:Record<string,{resolved?:unknown;integrity?:unknown;link?:unknown}>}).packages;
 if(!packages||typeof packages!=='object')throw new Error('lock缺少packages');
 const result=new Map<string,string>();
 for(const [name,item] of Object.entries(packages)){
  if(name==='')continue;
  if(item.link||typeof item.resolved!=='string'||typeof item.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity))throw new Error('依赖必须有固定公开tarball和sha512完整性');
  const url=new URL(item.resolved);
  if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.port||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('.tgz'))throw new Error('只接受公开registry.npmjs.org固定tarball');
  if(result.has(url.href)&&result.get(url.href)!==item.integrity)throw new Error('同一tarball声明冲突');result.set(url.href,item.integrity);
 }
 return [...result].sort(([a],[b])=>a.localeCompare(b)).map(([url,integrity])=>({url,integrity}));
}
/** Remove time/request metadata from cacache indexes; retain content keys, sizes and verified integrities. */
export function stableCacheIndex(text:string):string{
 const latest=new Map<string,{key:string;integrity:string;size:number;time:number}>();
 for(const line of text.split('\n').filter(Boolean)){
  const split=line.indexOf('\t');if(split<1)throw new Error('cache index形状未知');const body=line.slice(split+1);
  if(createHash('sha1').update(body).digest('hex')!==line.slice(0,split))throw new Error('cache index摘要无效');
  const entry=JSON.parse(body);if(typeof entry.key!=='string'||typeof entry.integrity!=='string'||!Number.isSafeInteger(entry.size))throw new Error('cache index内容未知');
  if(entry.key.includes('file:')||entry.key.includes('/var/tmp/'))continue; // Integrity-addressed content remains; omit scratch-path indexes.
  latest.set(entry.key,{key:entry.key,integrity:entry.integrity,size:entry.size,time:0});
 }
 return [...latest].sort(([a],[b])=>a.localeCompare(b)).map(([,entry])=>{const body=JSON.stringify(entry);return '\n'+createHash('sha1').update(body).digest('hex')+'\t'+body;}).join('');
}
async function files(root:string):Promise<string[]>{
 const out:string[]=[];const walk=async(path:string)=>{for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())out.push(file.slice(root.length+1));else throw new Error('资产不接受链接或特殊文件');}};await walk(root);return out.sort();
}
async function verifiedNpmTree(root:string,baseline:MountRow):Promise<void>{
 const active=new Set<string>();
 const allowed=['/usr/lib/node_modules','/usr/local/lib/node_modules','/usr/share/nodejs'];
 const walk=async(path:string)=>{const actual=await realpath(path);sourceMountReceipt(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')),actual,'/npm',baseline);if(!allowed.some(base=>actual.startsWith(base+'/')))throw new Error('npm资产越出系统公开代码目录');const info=await lstat(actual);if(info.uid!==0||(info.mode&0o022)!==0)throw new Error('npm资产未由管理员冻结');if(info.isDirectory()){if(active.has(actual))throw new Error('npm资产含目录环');active.add(actual);for(const name of await readdir(actual))await walk(join(actual,name));active.delete(actual);}else if(!info.isFile())throw new Error('npm资产类型未知');};await walk(root);
}
export async function prepareOfflineBundle(commit:string):Promise<{path:string;pin:string;assets:number;tarballs:number}>{
 await requireSyntheticVm();
 for(const name of ['NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])if(process.env[name])throw new Error('公开资产准备拒绝代理或Node预加载环境：'+name);
 if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('需要显式固定提交SHA');
 const baseline=trustedRootMount(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')));
 const root='/var/tmp/chvm-prep-'+randomBytes(6).toString('hex');
 const bundle=join(root,'bundle'),cache=join(root,'cache');let identity:Stats|undefined;
 const env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:join(root,'home'),USER:'synthetic-preparer',LANG:'C',LC_ALL:'C'};
 const command=async(args:string[])=>{const result=await runCommand(process.execPath,args,{env,cwd:root,timeoutMs:300_000});if(result.code!==0)throw new Error('公开离线资产准备失败（不输出命令诊断）');};
 const tree=fileURLToPath(new URL('../../../',import.meta.url));
 const git=async(args:string[])=>{const result=await runCommand('/usr/bin/git',['-c',`safe.directory=${tree}`,'-C',tree,...args],{env,cwd:root,timeoutMs:30_000});if(result.code!==0)throw new Error('固定Git源不可读');return result.stdout;};
 let complete=false;
 try{
  sourceMountReceipt(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')),root,root,baseline);
  await mkdir(root,{mode:0o700});identity=await lstat(root);
  await mkdir(bundle,{mode:0o755});await mkdir(join(root,'home'),{mode:0o700});
  const lock=JSON.parse(await git(['show',commit+':package-lock.json']));const tarballs=publicLockedTarballs(lock);
  await git(['archive','--format=tar','--output='+join(bundle,'source.tar'),commit,'--','.',':(exclude)foundation',':(exclude)references']);
  const candidates=['/usr/lib/node_modules/npm','/usr/local/lib/node_modules/npm','/usr/share/nodejs/npm'];let npm:string|undefined;
  for(const path of candidates)try{await verifiedNpmTree(path,baseline);await lstat(join(path,'bin/npm-cli.js'));npm=path;break;}catch{}
  if(!npm)throw new Error('没有完整管理员安装的公开npm运行资产');
  await cp(npm,join(bundle,'npm'),{recursive:true,dereference:true,errorOnExist:true,force:false});
  const flags=['--registry=https://registry.npmjs.org','--userconfig=/dev/null','--globalconfig='+join(root,'absent-global-npmrc'),'--cache='+cache,'--no-audit','--no-fund','--offline','--update-notifier=false'];
  for(const item of tarballs){
   // Fetch a fixed public URL and validate lock integrity before cache population. Redirects are not followed.
   const response=await fetch(item.url,{redirect:'error',signal:AbortSignal.timeout(120_000)});if(!response.ok)throw new Error('公开tarball不可取得');const data=Buffer.from(await response.arrayBuffer());
   if('sha512-'+createHash('sha512').update(data).digest('base64')!==item.integrity)throw new Error('公开tarball与固定lock不符');const artifact=join(root,'tarball-'+createHash('sha256').update(item.url).digest('hex')+'.tgz');await writeFile(artifact,data,{flag:'wx',mode:0o600});data.fill(0);
   // npm cache add does not install packages or execute their lifecycle scripts. Actual ci happens inside isolation.
   await command([join(bundle,'npm/bin/npm-cli.js'),'cache','add',artifact,...flags]);await rm(artifact);
  }
  await cp(join(cache,'_cacache'),join(bundle,'cache/_cacache'),{recursive:true});
  const index=join(bundle,'cache/_cacache/index-v5');for(const file of await files(index)){const normalized=stableCacheIndex(await readFile(join(index,file),'utf8'));if(normalized)await writeFile(join(index,file),normalized);else await rm(join(index,file));}
  await rm(join(bundle,'cache/_cacache/tmp'),{recursive:true,force:true});
  const hashes:Record<string,string>={};for(const file of await files(bundle))hashes[file]=createHash('sha256').update(await readFile(join(bundle,file))).digest('hex');
  const node=await realpath(process.execPath);sourceMountReceipt(parseMountInfo(await readFile('/proc/self/mountinfo','utf8')),node,'/node',baseline);
  const manifest={schema:'circle-hub-offline-build@1',source_commit:commit,node_sha256:createHash('sha256').update(await readFile(node)).digest('hex'),files:hashes};
  const bytes=JSON.stringify(manifest)+'\n';await writeFile(join(bundle,'manifest.json'),bytes,{mode:0o644,flag:'wx'});complete=true;
  return {path:bundle,pin:createHash('sha256').update(bytes).digest('hex'),assets:Object.keys(hashes).length,tarballs:tarballs.length};
 }finally{
  // Preserve completed assets for root-only sealing; failed preparation contains public synthetic code only.
  if(identity){const current=await lstat(root);if(current.dev!==identity.dev||current.ino!==identity.ino||current.uid!==identity.uid||current.mode!==identity.mode)throw new Error('准备目录身份改变，不按名字清理');if(!complete)await rm(root,{recursive:true});else{await rm(cache,{recursive:true,force:true});await rm(join(root,'home'),{recursive:true});}}
 }
}
if(import.meta.main){
 const [action,...args]=process.argv.slice(2);
 if(action==='prepare'&&args.length===1){const result=await prepareOfflineBundle(args[0]!);process.stdout.write(JSON.stringify(result)+'\n');}
 else if(action==='seal'&&args.length===2){const result=await sealPreparedOfflineBundle(args[0]!,args[1]!);process.stdout.write(JSON.stringify(result)+'\n');}
 else throw new Error('用法：prepare <固定提交SHA> | seal <本次prepared bundle> <清单SHA>');
}
