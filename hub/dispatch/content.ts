// Check the exact admitted bytes. What is dispatched is content, and content is not refused for looking like a credential
// (issue 194, decisions 154 and 161): only the digest of the admitted bytes decides.
import {sha256Hex} from '../records/api.ts';
import type {ParserRegistry} from '../refs/api.ts';
export function verifiedContent(bytes:Uint8Array,sha256:string,_mediaType:string,_parsers?:ParserRegistry):boolean {
 return sha256Hex(bytes)===sha256;
}
