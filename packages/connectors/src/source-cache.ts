import {readFile,writeFile,mkdir,rename,unlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {canonicalHash,requireCondition,sha256} from '../../contracts/src/index.ts';
import {LocalObjects} from '../../knowledge/src/objects.ts';
import type {RawReturn} from './readonly-sdk.ts';

// This is a reconstructible connector cache. B separately verifies and stores receipts.
export class SourceCache {
  directory?:string;memory=new Map<string,RawReturn>();objects=new Map<string,Buffer>();metadata=new Map<string,any>();
  constructor(directory?:string){this.directory=directory;}
  async getMetadata(identity:unknown):Promise<any|null>{
    const key=canonicalHash(identity);if(!this.directory)return this.metadata.get(key)??null;
    try{return JSON.parse(await readFile(join(this.directory,'indexes',`${key}.json`),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async updateMetadata(identity:unknown,update:(current:any|null)=>any):Promise<void>{
    const key=canonicalHash(identity);if(!this.directory){this.metadata.set(key,update(this.metadata.get(key)??null));return;}
    const directory=join(this.directory,'indexes');await mkdir(directory,{recursive:true,mode:0o700});const lock=join(directory,`${key}.lock`),deadline=Date.now()+15_000;
    while(true){try{await writeFile(lock,'locked',{flag:'wx',mode:0o600});break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;try{if(Date.now()-(await stat(lock)).mtimeMs>10_000)await unlink(lock);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      requireCondition(Date.now()<deadline,'SOURCE_UNREACHABLE','Source cache index is still pending');await delay(25);
    }}
    try{const current=await this.getMetadata(identity),temporary=join(directory,`${key}.${randomUUID()}.tmp`);await writeFile(temporary,JSON.stringify(update(current)),{mode:0o600});await rename(temporary,join(directory,`${key}.json`));}finally{await unlink(lock).catch(()=>{});}
  }
  async get(key:string):Promise<RawReturn|null>{
    if(!this.directory){const raw=this.memory.get(key);if(!raw)return null;const bytes=this.objects.get(raw.sha256)!;requireCondition(sha256(bytes)===raw.sha256,'SOURCE_HASH_MISMATCH','Source cache SHA differs');return {...raw,bytes:Buffer.from(bytes)};}
    let pointer:any;try{pointer=JSON.parse(await readFile(join(this.directory,'pointers',key),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    const bytes=await new LocalObjects(join(this.directory,'objects')).getObject({Bucket:'evidence',Key:pointer.sha256});return {...pointer,bytes};
  }
  async put(key:string,raw:RawReturn):Promise<void>{
    requireCondition(sha256(raw.bytes)===raw.sha256,'SOURCE_HASH_MISMATCH','Source cache input SHA differs');
    if(!this.directory){this.objects.set(raw.sha256,Buffer.from(raw.bytes));this.memory.set(key,{...raw,bytes:Buffer.alloc(0)});return;}
    await new LocalObjects(join(this.directory,'objects')).putObject({Bucket:'evidence',Key:raw.sha256,Body:raw.bytes});const dir=join(this.directory,'pointers');await mkdir(dir,{recursive:true,mode:0o700});
    const {bytes,...pointer}=raw,path=join(dir,key),temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(pointer),{mode:0o600});await rename(temporary,path);
  }
  async load(identity:unknown,read:()=>Promise<RawReturn>):Promise<RawReturn>{
    const key=canonicalHash(identity),prior=await this.get(key);if(prior)return prior;
    if(!this.directory){const raw=await read();await this.put(key,raw);return raw;}
    const locks=join(this.directory,'locks');await mkdir(locks,{recursive:true,mode:0o700});const lock=join(locks,key),deadline=Date.now()+15_000;
    while(true){try{await writeFile(lock,'locked',{flag:'wx',mode:0o600});break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const found=await this.get(key);if(found)return found;try{if(Date.now()-(await stat(lock)).mtimeMs>10_000)await unlink(lock);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      requireCondition(Date.now()<deadline,'SOURCE_UNREACHABLE','Source cache fetch is still pending');await delay(25);
    }}
    try{const second=await this.get(key);if(second)return second;const raw=await read();await this.put(key,raw);return raw;}finally{await unlink(lock).catch(()=>{});}
  }
}
