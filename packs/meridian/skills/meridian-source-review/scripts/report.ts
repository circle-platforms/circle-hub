import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Provide input and output paths');
const value=JSON.parse(await readFile(input,'utf8')),bytes=Buffer.from(value.base64,'base64');
if(typeof value.query!=='string'||!value.query||createHash('sha256').update(bytes).digest('hex')!==value.sha256)throw new Error('Source SHA or literal query is invalid');
const matches=bytes.toString('utf8').split(/\r?\n/).flatMap((text,line)=>text.includes(value.query)?[{line:line+1,text}]:[]);
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({productLine:'meridian',sourceSha256:value.sha256,status:matches.length?'observed':'unknown',proves:'literal-source-match',matches,semanticSupport:'not-asserted'},null,2)+'\n');
