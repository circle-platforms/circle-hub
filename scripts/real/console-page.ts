// Owner-run read-only console probe. Never print tokens, paths, names, response bodies or exception messages.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {parse,type DefaultTreeAdapterMap} from 'parse5';

export interface PageMetrics {
  scripts: number;
  externalAddresses: number;
  tableRows: number[];
  sha256: string;
}

/** Inspect resource-bearing HTML and CSS syntax, including embedded documents, without following a URL. */
function externalAddresses(body:string,scriptingEnabled:boolean):number {
  const attributes=new Set(['href','src','srcset','imagesrcset','action','formaction','poster','data','ping','background','cite','manifest','icon']);
  const external=(value:string)=>{
    const address=value.replace(/[\t\r\n]/g,'').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g,'');
    return /^[a-z][a-z0-9+.-]*:/i.test(address)||(/^[\\/]{2}/).test(address);
  };
  const candidates=(value:string):string[]=>{
    const urls:string[]=[];let at=0;
    while(at<value.length){
      while(at<value.length&&/[\t\n\f\r ,]/.test(value[at]))at++;
      const start=at;while(at<value.length&&!/[\t\n\f\r ]/.test(value[at]))at++;
      const token=value.slice(start,at);if(!token)break;
      urls.push(token.replace(/,+$/,''));
      if(token.endsWith(','))continue;
      let depth=0;
      while(at<value.length){const c=value[at++];if(c==='(')depth++;else if(c===')')depth=Math.max(0,depth-1);else if(c===','&&depth===0)break;}
    }
    return urls;
  };
  const cssDecode=(value:string)=>value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\r\f])|(.))/gi,(_all,hex:string|undefined,newline:string|undefined,char:string|undefined)=>{
    if(hex!==undefined){const code=Number.parseInt(hex,16);return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'\ufffd';}
    return newline===undefined?char??'':'';
  });
  const cssTargets=(css:string):string[]=>{
    const urls:string[]=[];let at=0;const functions:string[]=[];
    const escapeEnd=(start:number)=>{const match=/^\\(?:[0-9a-f]{1,6}(?:\r\n|[\t\n\f\r ])?|\r\n|[\s\S])/i.exec(css.slice(start));return start+(match?.[0].length??1);};
    const skip=()=>{while(at<css.length){if(/\s/u.test(css[at])){at++;continue;}if(css.startsWith('/*',at)){const end=css.indexOf('*/',at+2);at=end<0?css.length:end+2;continue;}break;}};
    const quoted=()=>{const quote=css[at++],start=at;while(at<css.length&&css[at]!==quote)at=css[at]==='\\'?escapeEnd(at):at+1;const value=css.slice(start,at);if(at<css.length)at++;return cssDecode(value);};
    while(at<css.length){
      skip();if(at>=css.length)break;
      if(css[at]==='"'||css[at]==="'"){const target=quoted();if(functions.at(-1)==='image-set'||functions.at(-1)==='-webkit-image-set')urls.push(target);continue;}
      if(css[at]==='('){functions.push('');at++;continue;}
      if(css[at]===')'){functions.pop();at++;continue;}
      const importing=css[at]==='@';if(importing)at++;
      const word=/^(?:[a-z_-]|\\(?:[0-9a-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[^\r\n\f]))(?:[a-z0-9_-]|\\(?:[0-9a-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[^\r\n\f]))*/i.exec(css.slice(at));
      if(!word){at++;continue;}
      at+=word[0].length;const name=cssDecode(word[0]).toLowerCase();skip();
      if(importing&&name==='import'&&(css[at]==='"'||css[at]==="'")){urls.push(quoted());continue;}
      if(css[at]!=='(')continue;
      if(name!=='url'){functions.push(name);at++;continue;}
      at++;skip();
      if(css[at]==='"'||css[at]==="'"){urls.push(quoted());skip();if(css[at]===')')at++;continue;}
      const start=at;while(at<css.length&&css[at]!==')')at=css[at]==='\\'?escapeEnd(at):at+1;
      urls.push(cssDecode(css.slice(start,at)).trim());if(at<css.length)at++;
    }
    return urls;
  };
  // HTML shared-declarative-refresh-steps: delay, optional separator and URL=, then optional quotes.
  const refreshTarget=(value:string):string|null=>{
    let at=0;const skip=()=>{while(at<value.length&&/[\t\n\f\r ]/.test(value[at]))at++;};skip();
    const start=at;while(at<value.length&&/[0-9]/.test(value[at]))at++;
    if(at===start&&value[at]!=='.')return null;
    while(at<value.length&&/[0-9.]/.test(value[at]))at++;
    if(at<value.length&&!/[;,\t\n\f\r ]/.test(value[at]))return null;
    skip();if(value[at]===';'||value[at]===',')at++;skip();
    if(at===value.length)return null;
    let target=value.slice(at);const prefix=/^url[\t\n\f\r ]*=[\t\n\f\r ]*/i.exec(target);
    if(prefix)target=target.slice(prefix[0].length);
    if(target[0]==='"'||target[0]==="'"){const quote=target[0];target=target.slice(1);const end=target.indexOf(quote);if(end>=0)target=target.slice(0,end);}
    return target;
  };
  let count=0;
  const pending:DefaultTreeAdapterMap['node'][]=[parse(body,{scriptingEnabled})];
  while(pending.length){
    const node=pending.pop()!;
    if('childNodes' in node)for(const child of node.childNodes)pending.push(child);
    if('content' in node)pending.push(node.content);
    if(!('tagName' in node))continue;
    const values=new Map(node.attrs.map(attribute=>[attribute.name.toLowerCase(),attribute.value]));
    if(node.tagName==='style'){
      const css=node.childNodes.flatMap(child=>child.nodeName==='#text'&&'value' in child?[child.value]:[]).join('');
      count+=cssTargets(css).filter(external).length;
    }
    for(const attribute of node.attrs){
      const name=attribute.name.toLowerCase().split(':').at(-1)!,value=attribute.value;
      if(name==='style')count+=cssTargets(value).filter(external).length;
      else if(name==='srcdoc')pending.push(parse(value,{scriptingEnabled}));
      else if(attributes.has(name))count+=(name==='srcset'||name==='imagesrcset'?candidates(value):name==='ping'?value.split(/\s+/u):[value]).filter(external).length;
      else if(/url\s*\(/i.test(cssDecode(value)))count+=cssTargets(value).filter(external).length;
    }
    if(node.namespaceURI==='http://www.w3.org/2000/svg'&&(node.tagName==='set'||node.tagName==='animate')&&attributes.has((values.get('attributename')??'').toLowerCase().split(':').at(-1)!)){
      for(const name of ['to','from','by']){const value=values.get(name);if(value!==undefined&&external(value))count++;}
      count+=(values.get('values')??'').split(';').filter(external).length;
    }
    if(node.tagName==='meta'&&values.get('http-equiv')?.trim().toLowerCase()==='refresh'){
      const target=refreshTarget(values.get('content')??'');
      if(target!==null&&external(target))count++;
    }
  }
  return count;
}

/** Counts markup only, without interpreting stored case names as executable HTML. */
export function summarizePage(body: string): PageMetrics {
  // Session nonces are not page content; leave every other byte in the evidence digest unchanged.
  const stableBody=body.replace(/<input\b[^>]*>/gi,tag=>/(?:\s)name\s*=\s*["']csrf["']/i.test(tag)
    ? tag.replace(/(\bvalue\s*=\s*)(["'])(.*?)\2/i,(_all,prefix:string,quote:string)=>`${prefix}${quote}[csrf]${quote}`) : tag);
  return {
    scripts: (body.match(/<script\b/gi) ?? []).length,
    externalAddresses: Math.max(externalAddresses(body,true),externalAddresses(body,false)),
    tableRows: [...body.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => {
      const content = match[1].replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/gi, '');
      return [...content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].filter((row) => /<td\b/i.test(row[1])).length;
    }),
    sha256: createHash('sha256').update(stableBody, 'utf8').digest('hex').slice(0, 12),
  };
}

const csrfOf = (body: string): string | undefined => /<input\b[^>]*name="csrf"[^>]*value="([A-Za-z0-9_-]+)"/i.exec(body)?.[1];

export interface ProbeResult extends PageMetrics {
  status: number;
  csp: boolean;
  loginStatus: number;
  logoutStatus: number;
}

/** Sign in, fetch exactly one requested page, and sign out even if the requested page fails. No redirect is followed. */
export async function probeConsole(options: { url: string; path: string; token: string }): Promise<ProbeResult> {
  const base = new URL(options.url);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('invalid origin');
  const target = new URL(options.path, base);
  if (!options.path.startsWith('/console/') || target.origin !== base.origin || !target.pathname.startsWith('/console/') || target.hash || target.pathname === '/console/login' || target.pathname === '/console/logout') throw new Error('invalid path');
  const token = options.token.trim().replace(/^Bearer[ \t]+/i, '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid token');
  const jar = new Map<string, string>();
  const fetchPage = async (path: string, fields?: Record<string, string>): Promise<Response> => {
    const reply = await fetch(new URL(path, base), {
      method: fields === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), ...(fields === undefined ? {} : { origin: base.origin, 'content-type': 'application/x-www-form-urlencoded' }) },
      ...(fields === undefined ? {} : { body: new URLSearchParams(fields).toString() }),
    });
    for (const cookie of reply.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]; const equals = pair.indexOf('=');
      const name = pair.slice(0, equals);
      if (equals > 0 && ['circle_hub_login', 'circle_hub_session'].includes(name)) jar.set(name, pair.slice(equals + 1));
    }
    return reply;
  };
  const form = await fetchPage('/console/login');
  const nonce = csrfOf(await form.text());
  if (form.status !== 200 || nonce === undefined) throw new Error('login form unavailable');
  const logged = await fetchPage('/console/login', { csrf: nonce, token });
  await logged.text();
  if (logged.status !== 303 || !jar.get('circle_hub_session')) throw new Error('login refused');
  let csrf: string | undefined;
  let metrics: Omit<ProbeResult, 'logoutStatus'>;
  let logoutStatus = 0;
  try {
    const reply = await fetchPage(`${target.pathname}${target.search}`);
    const body = await reply.text();
    csrf = csrfOf(body);
    metrics = { status: reply.status, csp: reply.headers.has('content-security-policy'), loginStatus: logged.status, ...summarizePage(body) };
  } finally {
    if (csrf === undefined) {
      const home = await fetchPage('/console/runs');
      csrf = csrfOf(await home.text());
    }
    if (csrf === undefined) throw new Error('logout form unavailable');
    const reply = await fetchPage('/console/logout', { csrf });
    logoutStatus = reply.status;
    await reply.text();
    if (logoutStatus !== 303) throw new Error('logout refused');
  }
  return { ...metrics, logoutStatus };
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2); const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]; const value = args[i + 1];
      if (!['--token-file', '--path', '--url'].includes(key) || values.has(key) || value === undefined || value.startsWith('--')) throw new Error('invalid arguments');
      values.set(key, value);
    }
    if (!values.has('--token-file') || !values.has('--path')) throw new Error('missing arguments');
    const result = await probeConsole({ url: values.get('--url') ?? 'http://127.0.0.1:7420', path: values.get('--path')!, token: await readFile(values.get('--token-file')!, 'utf8') });
    process.stdout.write(`登录状态码 ${result.loginStatus}；状态码 ${result.status}；退出状态码 ${result.logoutStatus}\nCSP ${result.csp ? '有' : '无'}；脚本标签 ${result.scripts}；外部地址 ${result.externalAddresses}\n`);
    result.tableRows.forEach((rows, i) => process.stdout.write(`表 ${i + 1}：${rows} 行\n`));
    process.stdout.write(`正文 SHA-256 ${result.sha256}\n`);
    if (result.status !== 200 || !result.csp || result.scripts !== 0 || result.externalAddresses !== 0) process.exitCode = 1;
  } catch {
    process.stderr.write('控制台检查未完成\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
