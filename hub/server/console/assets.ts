// Public constants only: no directory or user-controlled path is ever served as a console asset.
import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {brotliCompressSync,constants,gzipSync} from 'node:zlib';
import {CSS} from './style.ts';
import {THEME_SCRIPT} from './theme.ts';
import {LIVE_SCRIPT} from './script.ts';
function asset(body:string,extension:'css'|'js'){
 const hash=createHash('sha256').update(body).digest();
 return Object.freeze({body,path:`/console/assets/${hash.toString('hex')}.${extension}`,integrity:`sha256-${hash.toString('base64')}`,type:extension==='css'?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});
}
export const CONSOLE_CSS=asset(CSS,'css');
export const CONSOLE_THEME=asset(THEME_SCRIPT,'js');
export const CONSOLE_LIVE=asset(LIVE_SCRIPT,'js');
const assets=new Map<string,ReturnType<typeof asset>>([CONSOLE_CSS,CONSOLE_THEME,CONSOLE_LIVE].map(value=>[value.path,value]));

/** The codings an asset is sent in, in the order of preference: Brotli where the client takes it, then gzip. */
export type AssetCoding='br'|'gzip';
const CODINGS:readonly AssetCoding[]=['br','gzip'];
const encoded=new Map<string,Buffer>();
/**
 * An asset's bytes in one coding, made on the first request for it and kept: the three assets are constants of the
 * release, public and the same for everyone, so compressing them tells a reader nothing. A page is never sent this way:
 * it carries the form token of its session, and a compressed answer that mixes a secret with what a request controls
 * leaks the secret through its length.
 */
function coded(value:ReturnType<typeof asset>,coding:AssetCoding):Buffer{
 const key=coding+value.path;let bytes=encoded.get(key);
 if(!bytes){
  const raw=Buffer.from(value.body,'utf8');
  bytes=coding==='br'?brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_MODE]:constants.BROTLI_MODE_TEXT,[constants.BROTLI_PARAM_QUALITY]:constants.BROTLI_MAX_QUALITY,[constants.BROTLI_PARAM_SIZE_HINT]:raw.length}}):gzipSync(raw,{level:constants.Z_BEST_COMPRESSION});
  encoded.set(key,bytes);
 }
 return bytes;
}
/**
 * The coding to answer in, from Accept-Encoding (RFC 9110, 12.5.3): a coding the client names with a weight above zero,
 * or covers with `*`, the preferred one first. None is the bytes as they are, which every client takes.
 */
export function assetCoding(header:string|string[]|undefined):AssetCoding|null{
 const weights=new Map<string,number>();
 for(const part of (Array.isArray(header)?header.join(','):header??'').split(',')){
  const [name,...params]=part.split(';').map(text=>text.trim().toLowerCase());if(!name)continue;
  const q=params.find(param=>param.startsWith('q='));const weight=q===undefined?1:Number(q.slice(2));
  weights.set(name,Number.isFinite(weight)?weight:0);
 }
 return CODINGS.find(coding=>(weights.get(coding)??weights.get('*')??0)>0)??null;
}
export function sendConsoleAsset(request:IncomingMessage,response:ServerResponse,url:URL):void{
 request.resume();
 const value=assets.get(url.pathname);
 const headers={'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
 if(!value||url.search){response.writeHead(404,{...headers,'cache-control':'no-store'});response.end();return;}
 if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405,{...headers,allow:'GET, HEAD','cache-control':'no-store'});response.end();return;}
 // Each coding is its own representation, with its own validator; a cache keeps them apart by Vary.
 const coding=assetCoding(request.headers['accept-encoding']);
 const etag=coding===null?`"${value.integrity}"`:`"${value.integrity}-${coding}"`;
 const cached={...headers,'content-type':value.type,'cache-control':'public, max-age=31536000, immutable',etag,vary:'Accept-Encoding',...(coding===null?{}:{'content-encoding':coding})};
 if(request.headers['if-none-match']?.split(',').some(tag=>tag.trim()===etag||tag.trim()==='W/'+etag||tag.trim()==='*')){response.writeHead(304,cached);response.end();return;}
 const bytes=coding===null?Buffer.from(value.body,'utf8'):coded(value,coding);
 response.writeHead(200,{...cached,'content-length':bytes.length});
 response.end(request.method==='HEAD'?undefined:bytes);
}
