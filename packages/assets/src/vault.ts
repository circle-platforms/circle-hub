import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';

export class PrivateVault {
  #directory:string;#key?:Buffer;
  constructor(directory:string){this.#directory=directory;}
  async initialize():Promise<void>{
    if(this.#key)return;await mkdir(this.#directory,{recursive:true,mode:0o700});
    const keyFile=join(this.#directory,'.key');
    try{await writeFile(keyFile,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    this.#key=await readFile(keyFile);if(this.#key.length!==32)throw new Error('Private credential key is unavailable');
  }
  path(reference:string):string{if(!/^[a-f0-9-]{36}$/.test(reference))throw new Error('Invalid private reference');return join(this.#directory,`${reference}.sealed`);}
  async put(value:string,binding:string):Promise<string>{
    await this.initialize();const id=randomUUID(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key!,iv);cipher.setAAD(Buffer.from(binding));
    const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    await writeFile(this.path(id),JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),bytes:bytes.toString('base64')}),{flag:'wx',mode:0o600});return id;
  }
  async get(reference:string,binding:string):Promise<string>{
    await this.initialize();const stored=JSON.parse(await readFile(this.path(reference),'utf8'));
    const decipher=createDecipheriv('aes-256-gcm',this.#key!,Buffer.from(stored.iv,'base64'));decipher.setAAD(Buffer.from(binding));decipher.setAuthTag(Buffer.from(stored.tag,'base64'));
    return Buffer.concat([decipher.update(Buffer.from(stored.bytes,'base64')),decipher.final()]).toString('utf8');
  }
  async remove(reference:string):Promise<void>{await unlink(this.path(reference)).catch(()=>{});}
}
