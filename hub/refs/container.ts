// The same CRC-checked bounded ZIP decoder used by xlsx@1, without dropping opaque members.
import {readXlsxArchive} from './parsers/xlsx.ts';
export function readContainerMembers(bytes:Uint8Array):ReadonlyMap<string,Uint8Array> {
 return new Map([...readXlsxArchive(bytes)].map(([name,value])=>[name,new Uint8Array(value)]));
}
