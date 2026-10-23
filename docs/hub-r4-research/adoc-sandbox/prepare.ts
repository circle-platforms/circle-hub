// Explicit host-side download only; the sandbox never downloads dependencies or includes.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const CACHE = join(tmpdir(), 'circle-hub-adoc-research');
export const PINS = [
  { version:'4.1.1', published:'2026-10-05T10:42:45.284Z', entry:'package/build/browser/index.js', file:'core-4.mjs',
    integrity:'kwynyx6FXXi985Q9tfIPUitZ/2vzISYmcUVVZXkSamwD91I5nL7TJt33HXjnBYwfzugLu36RZuhNA/DB4fogEA==',
    sha256:'5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d',bytes:990496 },
  { version:'3.0.4', published:'2024-02-12T11:19:03.201Z', entry:'package/dist/browser/asciidoctor.js',file:'core-3.mjs',
    integrity:'41SDMi7iRRBViPe0L6VWFTe55bv6HEOJeRqMj5+E5wB1YPdUPuTucL4UAESPZM6OWmn4t/5qM5LusXomFUVwVQ==',
    sha256:'3ddfae166a45b14b918229b698b961530d6d5d63e25151821689b702412d81be',bytes:1737178 },
] as const;
export const sha256 = (b:Uint8Array|string) => createHash('sha256').update(b).digest('hex');
function member(tar:Buffer, name:string):Buffer {
  for(let at=0;at+512<=tar.length;) {
    const header=tar.subarray(at,at+512),path=header.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8)||0;
    if(path===name) return tar.subarray(at+512,at+512+size);
    at+=512+Math.ceil(size/512)*512;
  }
  throw new Error(`pinned archive member missing: ${name}`);
}
export async function prepared(version:'4.1.1'|'3.0.4'):Promise<Buffer> {
  const pin=PINS.find(p=>p.version===version)!;
  const bytes=await readFile(join(CACHE,pin.file)).catch(()=>{throw new Error('Run node docs/hub-r4-research/adoc-sandbox/prepare.ts first (explicit public-registry download)');});
  if(bytes.length!==pin.bytes||sha256(bytes)!==pin.sha256) throw new Error('pinned browser bundle hash mismatch');
  return bytes;
}
if(import.meta.main) {
  await mkdir(CACHE,{recursive:true});
  for(const pin of PINS) {
    const r=await fetch(`https://registry.npmjs.org/@asciidoctor/core/-/core-${pin.version}.tgz`);
    if(!r.ok) throw new Error(`download failed: ${r.status}`);
    const compressed=Buffer.from(await r.arrayBuffer());
    if(createHash('sha512').update(compressed).digest('base64')!==pin.integrity) throw new Error('pinned tarball integrity mismatch');
    const bytes=member(gunzipSync(compressed),pin.entry);
    if(sha256(bytes)!==pin.sha256) throw new Error('pinned bundle mismatch');
    await writeFile(join(CACHE,pin.file),bytes);
    console.log(JSON.stringify({version:pin.version,bytes:bytes.length,sha256:pin.sha256}));
  }
}
