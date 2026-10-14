import {inflateRawSync} from 'node:zlib';

// The central directory locates compressed bytes; advertised output sizes never
// allocate the output buffer. zlib enforces the remaining hard expansion bound.
export function boundedUnzip(input:Uint8Array,options:{maxBytes?:number;maxEntries?:number}={}):Record<string,Uint8Array>{
  const bytes=Buffer.from(input),maxBytes=options.maxBytes??64*1024*1024,maxEntries=options.maxEntries??256;
  let end=-1;for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(bytes.readUInt32LE(offset)===0x06054b50){end=offset;break;}
  if(end<0||end+22>bytes.length||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw new Error('Malformed zip directory');
  const count=bytes.readUInt16LE(end+10),directory=bytes.readUInt32LE(end+16);if(count>maxEntries||directory>=end)throw new Error('Zip entry bound exceeded');
  const files:Record<string,Uint8Array>=Object.create(null);let cursor=directory,total=0;
  for(let index=0;index<count;index++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)throw new Error('Malformed zip entry');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nameSize=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
    if(flags&1||![0,8].includes(method)||[compressed,size,offset].includes(0xffffffff)||cursor+46+nameSize+extra+comment>end)throw new Error('Unsupported zip entry');
    const name=bytes.subarray(cursor+46,cursor+46+nameSize).toString('utf8'),parts=name.replace(/\/$/,'').split('/');if(!name||name.startsWith('/')||name.includes('\\')||/^[a-z]:/i.test(name)||parts.some(part=>part==='..'||part==='.'||!part)||Object.hasOwn(files,name))throw new Error('Unsafe zip entry name');
    if(offset+30>directory||bytes.readUInt32LE(offset)!==0x04034b50)throw new Error('Malformed local zip header');
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);if(start+compressed>directory||total>=maxBytes&&size>0)throw new Error('Zip expansion exceeds its bound');
    let output:Buffer;try{output=method===0?Buffer.from(bytes.subarray(start,start+compressed)):inflateRawSync(bytes.subarray(start,start+compressed),{maxOutputLength:Math.max(1,maxBytes-total)});}catch{throw new Error('Zip expanded bytes exceed the bound or are malformed');}
    total+=output.length;if(total>maxBytes)throw new Error('Zip expansion exceeds its bound');if(output.length!==size)throw new Error('Zip expanded size differs from its declaration');files[name]=output;cursor+=46+nameSize+extra+comment;
  }
  return files;
}
