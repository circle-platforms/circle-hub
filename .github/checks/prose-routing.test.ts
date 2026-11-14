import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isProseRoutingFile, proseRoutingHits, proseRoutingProblems, type SourceModule } from './prose-routing.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
const module = (source: string, file = 'hub/server/renderer.ts'): SourceModule => ({ file, source });
const hits = (source: string) => proseRoutingHits([module(source)]);
const bad = (source: string, operation: string) => assert.ok(hits(source).some(hit => hit.operation === operation), JSON.stringify(hits(source)));

for (const method of ['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search', 'replace', 'replaceAll', 'split']) {
  test(`fixture detects prose ${method} without recognizing its synthetic words`, () => {
    bad(`function render(error: {message: string}) { return error.message.${method}('arbitrary-fixture-omega', 'other'); }`, method);
  });
}
for (const method of ['test', 'exec']) test(`fixture detects regex ${method} on a prose alias`, () => {
  bad(`function render(error: {fix: string}) { const alias = error.fix; const pattern = /fixture-letters/; return pattern.${method}(alias); }`, method);
});
test('fixture follows renamed destructuring, concatenation and an array callback', () => {
  bad(`function render(error: {message:string}) { const {message: renamed} = error; const joined = [renamed, ''].join(' '); return /anything/.test(joined); }`, 'test');
  bad(`function render(item: {missing:string[]}) { return (item.missing ?? []).some(part => part.includes('anything')); }`, 'includes');
});
test('fixture follows helper arguments and helper return values through fixed point', () => {
  bad(`function copied(value:string) { return value.trim(); } function route(value:string) { return value.includes('anything'); } function render(error:{message:string}) { return route(copied(error.message)); }`, 'includes');
  bad(`function route(value:{raw:string}) { return value.raw.match(/anything/); } function render(error:{message:string}) { return route({raw:error.message}); }`, 'match');
});
test('fixture follows helper imports and aliases rather than exempting moved renderer logic', () => {
  const result = proseRoutingHits([
    module(`import { copied as renamed } from './helper.ts'; export function render(error:{message:string}) { return renamed(error.message); }`),
    module(`export function copied(input:string) { return input.includes('anything'); }`, 'hub/server/helper.ts'),
  ]);
  assert.ok(result.some(hit => hit.file === 'hub/server/helper.ts' && hit.operation === 'includes'), JSON.stringify(result));
});
test('fixture flags a prose-derived computed category or next-step lookup', () => {
  bad(`function render(error:{message:string}, table:Record<string,string>) { const key = error.message.trim(); return table[key]; }`, 'computed-index');
});
test('fixture does not treat structured code, reason and role branches as prose', () => {
  assert.deepEqual(hits(`function render(error:{code:string; call_error_reason:'absent'|'busy'},role:'admin'|'user') { if(error.code === 'CODE') return error.call_error_reason === 'busy' && role === 'admin' ? 'fact a' : 'fact b'; return ''; }`), []);
});
test('fixture does not permit renaming prose into a code property to bypass the rule', () => {
  bad(`function render(error:{message:string}) { const value={code:error.message}; return value.code.includes('anything'); }`, 'includes');
});
test('fixture parameter grammar parsing and closed arrays are not text classification', () => {
  assert.deepEqual(hits(`function parse(arg:string,cursor:string,roles:string[]) { const match=/^--name=([a-z]+)$/.exec(arg); return {match,cursor:/^[0-9]+:[a-z]+$/.test(cursor),role:roles.includes('admin')}; }`), []);
});
test('fixture fixed template interpolation and line layout preserve prose without routing it', () => {
  assert.deepEqual(hits('function render(error:{message:string;fix:string}) { return error.message.split(/\\r\\n|\\r|\\n/).map(line => `<p>${line}</p>`).join("") + `<p>${error.fix}</p>`; }'), []);
});
test('fixture pure punctuation completion is allowed but punctuation-derived categories are not', () => {
  assert.deepEqual(hits('function sentence(text:string) { const trimmed=text.trim(); return /[。！？]$/.test(trimmed) ? trimmed : `${trimmed}。`; } function render(error:{message:string}) { return sentence(error.message); }'), []);
  bad(`function render(error:{message:string}) { return /[。！？]$/.test(error.message) ? 'category-a' : 'category-b'; }`, 'test');
});
test('fixture HTML escaping and control escaping are not semantic replacements', () => {
  assert.deepEqual(hits(`const escapes={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}; function escape(text:string) { return text.replace(/[&<>"]/g, char=>escapes[char]); } function render(error:{message:string}) { return escape(error.message); }`), []);
  assert.deepEqual(hits(String.raw`function visible(line:string) { return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, char=> '\\x'+char.charCodeAt(0).toString(16).padStart(2,'0')); } function render(error:{message:string}) { return visible(error.message); }`), []);
});
test('fixture punctuation matcher cannot replace prose with a semantic outcome', () => {
  bad(`function render(error:{message:string}) { return error.message.replace(/[。]/g,'category-a'); }`, 'replace');
});
test('fixture scope includes CLI and helper files, excludes only tests/declarations/outside server', () => {
  assert.equal(isProseRoutingFile('hub/server/console/page.ts'), true);
  assert.equal(isProseRoutingFile('hub/server/cli-any.ts'), true);
  assert.equal(isProseRoutingFile('hub/server/any.test.ts'), false);
  assert.equal(isProseRoutingFile('hub/server/types.d.ts'), false);
  assert.equal(isProseRoutingFile('hub/dispatch/service.ts'), false);
});
test('fixture property shadowing and comments containing text APIs do not cause matches', () => {
  assert.deepEqual(hits(`// error.message.includes('anything')
function unused(error:{message:string}) { return error.message; }
function render(code:string) { const value=code; return value.includes('CODE'); }`), []);
});
test('fixture reports stable source coordinates and rejects syntax errors instead of skipping them', () => {
  const result=hits(`function render(error:{message:string}) {\n  return error.message.includes('anything');\n}`);
  assert.equal(result[0].line, 2); assert.ok(result[0].column > 0);
  assert.throws(()=>hits('function ('), /语法错误/);
});
test('fixture standard dynamically composed line-break regex remains formatting', () => {
  assert.deepEqual(hits('const breaks=new RegExp(`\\r\\n|[\\n\\r${String.fromCharCode(0x85,0x2028,0x2029)}]`, "g"); function oneLine(text:string){return text.replace(breaks," ");} function render(error:{message:string}){return oneLine(error.message);}'), []);
});
test('fixture fixed placeholder substitution is interpolation, not a phrase rewrite', () => {
  assert.deepEqual(hits('function fill(text:string,name:string){return text.replaceAll("<account>",name);} function render(error:{fix:string}){return fill(error.fix,"synthetic-user");}'), []);
  bad('function render(error:{message:string}){return error.message.replace(/[。]/g,"403");}', 'replace');
});
test('fixture serialized Html matching stays structural but rendered-word routing stays forbidden', () => {
  const prefix='class Html { constructor(public text:string){} } ';
  assert.deepEqual(hits(prefix+'function render(error:{message:string}){const body=new Html(error.message); const script=`<script src="${"/asset.js"}"></script>`;return body.text.replaceAll(script,"<script nonce=abc></script>");}'), []);
  bad(prefix+'function render(error:{message:string}){const body=new Html(error.message);return body.text.includes("anything")?"a":"b";}', 'includes');
});
test('fixture canonical stack-frame sanitizing never exempts message-word classification', () => {
  assert.deepEqual(hits('function strip(line:string){const clean=line.trim();if(!clean.startsWith("at "))return clean;return clean.replace(/(?:file:\\/\\/)?\\/[^: ]+/g,"$1");} function render(error:{stack:string,message:string}){return strip(error.stack??error.message);}'), []);
  bad('function render(error:{stack:string}){return error.stack.includes("anything")?"a":"b";}', 'includes');
});
test('fixture parameter text can parse URI grammar but cannot inspect arbitrary message words', () => {
  const prefix='declare namespace z {type infer<T>=T;} declare const InputSchema:{text:string}; ';
  assert.deepEqual(hits(prefix+'function parse(input:z.infer<typeof InputSchema>){return input.text.trim().startsWith("ref:");}'), []);
  bad(prefix+'function render(input:z.infer<typeof InputSchema>){return input.text.includes("anything");}', 'includes');
});
test('fixture command-token extraction solely checked against a registry is not routing', () => {
  const source='const registry=[{name:"work"}];function checked(name:string){if(!registry.some(row=>row.name===name))throw new Error("invalid");return name;}function tokens(text:string){const result:string[]=[];for(const match of text.matchAll(/tool +([a-z]+)/g))result.push(match[1]);return result;}function validate(text:string){for(const name of tokens(text))checked(name);}function render(error:{fix:string}){validate(error.fix);return error.fix;}';
  assert.deepEqual(hits(source), []);
  bad(source+'function route(error:{fix:string}){return tokens(error.fix).join(" ");}', 'matchAll');
});
test('fixture bound string and regex methods retain their original prose inputs', () => {
  bad('function render(error:{message:string}){const check=error.message.includes.bind(error.message);return check("anything");}', 'includes');
  bad('const pattern=/anything/;function render(error:{message:string}){const check=pattern.test.bind(pattern);return check(error.message);}', 'test');
});
test('fixture equality, switch and map keys cannot route by prose while empty checks remain formatting', () => {
  bad('function render(error:{message:string}){return error.message==="anything"?"a":"b";}', 'text-equality');
  bad('function render(error:{message:string}){switch(error.message){case "anything":return "a";default:return "b";}}', 'text-switch');
  bad('function render(error:{message:string},table:Map<string,string>){return table.get(error.message);}', 'text-key');
  assert.deepEqual(hits('function render(error:{message:string}){return error.message===""?"":error.message;}'), []);
});
test('fixture exact grouping retains whole structured fields instead of inferring a category from wording', () => {
  assert.deepEqual(hits('function render(rows:{kind:string;missing:string;next_action:string}[]){const groups=new Map<string,unknown>();for(const row of rows){const key=JSON.stringify([row.kind,row.missing,row.next_action]);const group=groups.get(key)??{kind:row.kind,missing:row.missing,next_action:row.next_action};groups.set(key,group);}return groups;}'), []);
  bad('function render(error:{message:string}){const table=new Map([["anything","category"]]);return table.get(error.message);}', 'text-key');
});
test('review 1 local function-value alias and alias chain still classify prose', () => {
  const classify='function classify(value:string){return value.includes("synthetic-token")?"occupied":"not_found";}';
  bad(classify+'function render(error:{message:string}){const alias=classify;return {category:alias(error.message)};}', 'includes');
  bad(classify+'function render(error:{message:string}){const one=classify;const two=one;return {category:two(error.message)};}', 'includes');
  assert.deepEqual(hits(classify+'function render(code:string){const alias=classify;return alias(code);}'), []);
});
for(const [name,expression,setup] of [
  ['capture','replacement','const replacement="category-a";'],
  ['property','config.replacement','const config={replacement:"category-a"};'],
  ['helper','replacement()','function replacement(){return "category-a";}'],
  ['unknown','replacement()','declare function replacement():string;'],
  ['mutable','replacement','let replacement="&amp;";replacement="category-a";'],
] as const) test(`review 2 ${name} callback output is not silently safe`,()=>{
  bad('function render(error:{fix:string}){'+setup+'return {next_action:error.fix.replace(/[。]/g,()=>'+expression+')};}', 'replace');
});
test('review 2 captured encoding constants, properties and helper results stay allowed',()=>{
  for(const [value,setup] of [
    ['replacement','const replacement="&amp;";'],
    ['config.replacement','const config={replacement:"&amp;"};'],
    ['replacement()','function replacement(){return "&amp;";}'],
  ]) assert.deepEqual(hits('function render(error:{message:string}){'+setup+'return error.message.replace(/[&]/g,()=>'+value+');}'), []);
});
const authored='declare namespace z{type infer<T>=T;}declare const InputSchema:{text:string};';
for(const [name,setup,value] of [
  ['alias','const value=input.text;','value'],
  ['destructure','const {text:value}=input;','value'],
  ['helper','function identity(value:string){return value;}const value=identity(input.text);','value'],
] as const) test(`review 3 formal URI ${name} preserves authored grammar origin`,()=>{
  assert.deepEqual(hits(authored+'function parse(input:z.infer<typeof InputSchema>){'+setup+'return '+value+'.trim().startsWith("ref:");}'), []);
});
test('review 3 same-shaped message aliases and overwritten formal values are still prose',()=>{
  bad('function render(error:{message:string}){const value=error.message;return value.trim().startsWith("ref:");}', 'startsWith');
  bad(authored+'function render(input:z.infer<typeof InputSchema>,error:{message:string}){let value=input.text;value=error.message;return value.startsWith("ref:");}', 'startsWith');
});
test('repository renderers contain zero prose routing and have no exceptions', () => {
  assert.deepEqual(proseRoutingProblems(root), []);
});
