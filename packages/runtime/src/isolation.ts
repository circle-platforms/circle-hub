import {access,realpath,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {ApiError} from '../../contracts/src/index.ts';
export interface IsolationPolicy{read:string[];write:string[];network:string[]}
const literal=(value:string)=>JSON.stringify(value);
async function rule(path:string){const resolved=await realpath(path),metadata=await stat(resolved);return `(${metadata.isDirectory()?'subpath':'literal'} ${literal(resolved)})`;}
// The untrusted process and every descendant inherit the same kernel policy.
// A JS VM and a clean HOME alone are not a boundary against another OS user file.
export async function isolatedProcess(command:string,args:string[],policy:IsolationPolicy){
  if(process.platform!=='darwin')throw new ApiError('SANDBOX_UNAVAILABLE',`This host is ${process.platform}. Skill runs and product Tool/Hook subprocesses need macOS seatbelt. The hub does not run them without process isolation. See docs/quickstart.md.`);
  try{await access('/usr/bin/sandbox-exec');}catch{throw new ApiError('SANDBOX_UNAVAILABLE','Process isolation is unavailable on this Mac. Skill runs and product Tool/Hook subprocesses need macOS seatbelt, and the hub does not run them without it. See docs/quickstart.md.');}
  const executable=await realpath(command),read=[executable,dirname(dirname(executable)),...policy.read];
  const system=['/System','/usr/lib','/usr/share','/usr/bin','/usr/sbin','/bin','/sbin','/dev','/private/etc/ssl','/private/etc/hosts','/private/etc/resolv.conf','/private/etc/localtime','/private/var/db/dyld','/Library/Apple'];
  for(const path of system)try{await access(path);read.push(path);}catch{/* Optional OS resources. */}
  const reads=await Promise.all([...new Set(read)].map(rule)),writes=await Promise.all([...new Set(policy.write)].map(rule)),networks=policy.network.map(value=>{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username||url.password)throw new ApiError('SANDBOX_UNAVAILABLE','Only approved loopback execution endpoints are supported');return `(remote tcp ${literal(`localhost:${url.port||(url.protocol==='https:'?'443':'80')}`)})`;});
  const excluding=(rules:string[])=>rules.length?`(require-all ${rules.map(value=>`(require-not ${value})`).join(' ')})`:'';
  const profile=`(version 1)(allow default)(deny file-read-data (require-all (vnode-type REGULAR-FILE) ${excluding(reads)}))(deny file-write* ${excluding(writes)})(deny network-outbound ${excluding(networks)})(deny process-info* (require-not (target self)))`;
  return {command:'/usr/bin/sandbox-exec',args:['-p',profile,executable,...args]};
}
