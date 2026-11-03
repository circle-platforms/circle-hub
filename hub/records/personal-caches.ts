// Extraction is a removable projection. Only exact, independently held versions may keep a usable cache.
import {readdir,lstat,chmod,rm,open} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import type {Database} from './db.ts';
export async function retirePersonalCaches(db:Database,owner:string,roots:ReadonlySet<string>){
 const rows=await db.query("SELECT value FROM record_index WHERE key='personal.pack.digest' AND value LIKE $1",[owner+'/%']);
 const digests=new Set(rows.rows.map(row=>String(row.value).slice(owner.length+1)).filter(hash=>/^[0-9a-f]{64}$/.test(hash)));
 const remove=async(path:string):Promise<void>=>{let entry;try{entry=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}if(entry.isDirectory()){await chmod(path,0o700);for(const name of await readdir(path))await remove(join(path,name));}await rm(path,{force:true,recursive:true});};
 const sync=async(path:string)=>{const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}};
 for(const root of roots){if(!isAbsolute(root))throw new TypeError('private cache root');let entries:string[];try{entries=await readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  for(const hash of digests){
   const held=await db.query(`SELECT 1 FROM run_pack_records WHERE digest=$1
    UNION ALL SELECT 1 FROM record_index i JOIN personal_record_bindings b ON b.record=i.digest WHERE i.key='personal.pack.digest' AND i.value=b.owner||'/'||$1 AND b.owner<>$2 AND NOT EXISTS(SELECT 1 FROM personal_purges p WHERE (p.owner,p.epoch)=(b.owner,b.epoch))
    UNION ALL SELECT 1 FROM object_holds h WHERE h.sha256=$1 AND NOT h.artifact AND NOT EXISTS(SELECT 1 FROM personal_record_bindings b WHERE b.record=h.record) LIMIT 1`,[hash,owner]);
   if(!held.rowCount){for(const name of entries)if(name===hash||name.startsWith('.tmp-'+hash+'-'))await remove(join(root,name));}
   const quarantine=join(root,'.quarantine');let discarded:string[]=[];try{discarded=await readdir(quarantine);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   for(const name of discarded)if(name.startsWith(hash+'-'))await remove(join(quarantine,name));
   if(discarded.length)await sync(quarantine);
  }
  await sync(root);
 }
}
