// Public constants only: no directory or user-controlled path is ever served as a console asset.
import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
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
export function sendConsoleAsset(request:IncomingMessage,response:ServerResponse,url:URL):void{
 request.resume();
 const value=assets.get(url.pathname);
 const headers={'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
 if(!value||url.search){response.writeHead(404,{...headers,'cache-control':'no-store'});response.end();return;}
 if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405,{...headers,allow:'GET, HEAD','cache-control':'no-store'});response.end();return;}
 const etag=`"${value.integrity}"`,cached={...headers,'content-type':value.type,'cache-control':'public, max-age=31536000, immutable',etag};
 if(request.headers['if-none-match']?.split(',').some(tag=>tag.trim()===etag||tag.trim()==='W/'+etag||tag.trim()==='*')){response.writeHead(304,cached);response.end();return;}
 response.writeHead(200,{...cached,'content-length':Buffer.byteLength(value.body)});
 response.end(request.method==='HEAD'?undefined:value.body);
}
