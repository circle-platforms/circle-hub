import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { createTestServer, type TestServer } from './testing.ts';
let server: TestServer;
before(async()=>{server=await createTestServer();});after(async()=>{await server?.close();});
interface Reply {status:number;body:string;headers:Record<string,string|string[]|undefined>}
const cookie=(r:Reply,name:string):string=>(r.headers['set-cookie'] as string[] ?? []).find(row=>row.startsWith(name+'='))?.split(';')[0] ?? '';
const csrf=(body:string):string=>/name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
async function send(path:string,method='GET',data?:Record<string,string>,session='',origin=true):Promise<Reply>{
  return new Promise((resolve,reject)=>{const req=request(new URL(path,server.url),{method,headers:{...(session?{cookie:session}:{}),...(data?{'content-type':'application/x-www-form-urlencoded'}:{}),...(origin?{origin:server.url}:{})}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));});req.on('error',reject);req.end(data?new URLSearchParams(data).toString():undefined);});
}
async function login(fields:Record<string,string>):Promise<Reply>{const page=await send('/console/login');return send('/console/login','POST',{...fields,csrf:csrf(page.body)},cookie(page,'circle_hub_login'));}
test('initial passwords cannot bypass the first change through pages, APIs, management or a Circle token',async()=>{
  const initial='synthetic-initial-password';
  const user=await server.records.principals.createUser(server.admin.principal,'合成初始账户','user',{password:initial,mustChange:true});
  const circle=await server.records.principals.issueToken(server.admin.principal,user.id,'合成 Circle');
  assert.equal((await login({token:circle.token})).status,401,'member tokens are not console passwords');
  const signed=await login({username:user.name,password:initial});assert.equal(signed.status,303);assert.match(String(signed.headers.location),/^\/console\/password/);
  const session=cookie(signed,'circle_hub_session');
  assert.equal((await send('/console/overview','GET',undefined,session)).status,303);
  assert.equal((await send('/console/api/status','GET',undefined,session)).status,403);
  assert.equal((await send('/console/admin/do/member-add','POST',{name:'禁止创建'},session)).status,303);
  const form=await send('/console/password','GET',undefined,session);assert.equal(form.status,200);
  assert.ok(!form.body.includes(initial));assert.match(form.body,/首次登录必须修改口令/);
  const next='synthetic-changed-password';
  assert.equal((await send('/console/password','POST',{current:initial,password:next,confirm:next,csrf:'wrong'},session)).status,403);
  const changed=await send('/console/password','POST',{current:initial,password:next,confirm:next,csrf:csrf(form.body)},session);
  assert.equal(changed.status,200);assert.match(changed.body,/口令已修改/);
  assert.equal((await send('/console/team','GET',undefined,session)).status,303,'old console session is revoked');
  assert.equal((await login({username:user.name,password:initial})).status,401);
  const fresh=await login({username:user.name,password:next});assert.equal(fresh.headers.location,'/console/overview');
  assert.equal((await server.records.principals.authenticate('Bearer '+circle.token))?.id,user.id,'MCP token stays bound to its account');
});
test('only administrators reset a member password and the generated value is returned once',async()=>{
  const initial='synthetic-before-reset';
  const user=await server.records.principals.createUser(server.admin.principal,'合成待重置成员','user',{password:initial,mustChange:false});
  const logged=await login({username:user.name,password:initial}), memberSession=cookie(logged,'circle_hub_session');
  const mine=await send('/console/password','GET',undefined,memberSession);
  assert.equal((await send('/console/password/reset','POST',{csrf:csrf(mine.body),user:server.admin.user.id},memberSession)).status,403);
  const loggedAdmin=await login({token:server.admin.token}), adminSession=cookie(loggedAdmin,'circle_hub_session');
  const team=await send(`/console/team/${user.id}`,'GET',undefined,adminSession);assert.match(team.body,/重置口令/);
  const reset=await send('/console/password/reset','POST',{csrf:csrf(team.body),user:user.id},adminSession);assert.equal(reset.status,200);
  const password=/<pre[^>]*>([^<]+)<\/pre>/.exec(reset.body)?.[1];assert.ok(password);assert.match(reset.body,/仅显示一次/);
  assert.equal((await send('/console/team','GET',undefined,memberSession)).status,303);
  assert.ok(!(await send(`/console/team/${user.id}`,'GET',undefined,adminSession)).body.includes(password));
  assert.equal((await login({username:user.name,password:initial})).status,401);
  assert.match(String((await login({username:user.name,password})).headers.location),/^\/console\/password/);
  assert.ok(!server.logs.join('\n').includes(password));
});
test('the failure limit also applies to unknown accounts and cannot be bypassed by fetching a fresh form',async()=>{
  for(let i=0;i<5;i++) assert.equal((await login({username:'合成不存在账户',password:'synthetic-wrong-password'})).status,401);
  assert.equal((await login({username:'合成不存在账户',password:'synthetic-wrong-password'})).status,429);
});
test('an administrator backup token cannot bypass a mandatory password change or reset other accounts first',async()=>{
  const initial='synthetic-admin-initial';
  const admin=await server.records.principals.createUser(server.admin.principal,'合成初始管理员','admin',{password:initial,mustChange:true});
  const backup=await server.records.principals.issueToken(server.admin.principal,admin.id,'合成备用令牌');
  const signed=await login({token:backup.token});assert.match(String(signed.headers.location),/^\/console\/password/);
  const session=cookie(signed,'circle_hub_session');
  assert.equal((await send('/console/api/me','GET',undefined,session)).status,403);
  const form=await send('/console/password','GET',undefined,session);
  assert.equal((await send('/console/password/reset','POST',{csrf:csrf(form.body),user:server.admin.user.id},session)).status,403);
});
test('login preserves passwords as typed and accepts the same Unicode username length as account creation',async()=>{
  const name='合成'+'😀'.repeat(70), password=' synthetic Unicode password ';
  await server.records.principals.createUser(server.admin.principal,name,'user',{password,mustChange:false});
  assert.equal((await login({username:name,password:password.trim()})).status,401);
  const signed=await login({username:name,password});
  assert.equal(signed.status,303);assert.equal(signed.headers.location,'/console/overview');
});
