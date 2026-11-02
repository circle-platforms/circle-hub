import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { SYNTHETIC_CONSOLE_PASSWORD, createTestServer, testConsoleCredentials, type TestServer } from './testing.ts';
import { createCommandBridge } from './command-bridge.ts';
import { handleConsole, type ConsoleOptions } from './console/index.ts';
import { SessionStore } from './console/session.ts';
import { JobStore } from './console/manage.ts';
import { PackStaging } from './console/staging.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
let server: TestServer;
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres({socket:true,passwordless:true});server=await createTestServer({postgres,bridge:records=>createCommandBridge({
  cwd:records.dataDir,
  env:{CIRCLE_HUB_DATA_DIR:records.dataDir,CIRCLE_HUB_LOG_DIR:records.dataDir+'/logs',CIRCLE_HUB_HOST:'127.0.0.1',CIRCLE_HUB_PORT:'0',
    ...(records.database.host.startsWith('/') ? {CIRCLE_HUB_DATABASE_SOCKET_DIR:records.database.host} : {CIRCLE_HUB_DATABASE_HOST:records.database.host}),CIRCLE_HUB_DATABASE_PORT:String(records.database.port),
    CIRCLE_HUB_DATABASE_NAME:records.database.database,CIRCLE_HUB_DATABASE_USER:records.database.user,CIRCLE_HUB_KEYCHAIN_SERVICE:'circle-hub-test'},
  overrides:{keyProvider:()=>records.keyProvider},
})});});after(async()=>{try{await server?.close();}finally{await postgres?.stop();}});
interface Reply {status:number;body:string;headers:Record<string,string|string[]|undefined>}
const cookie=(r:Reply,name:string):string=>(r.headers['set-cookie'] as string[] ?? []).find(row=>row.startsWith(name+'='))?.split(';')[0] ?? '';
const csrf=(body:string):string=>/name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
async function send(path:string,method='GET',data?:Record<string,string>,session='',origin:boolean|string=true):Promise<Reply>{
  return new Promise((resolve,reject)=>{const req=request(new URL(path,server.url),{method,headers:{...(session?{cookie:session}:{}),...(data?{'content-type':'application/x-www-form-urlencoded'}:{}),...(origin?{origin:typeof origin==='string'?origin:server.url}:{})}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));});req.on('error',reject);req.end(data?new URLSearchParams(data).toString():undefined);});
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
  assert.ok(!form.body.includes(initial));assert.match(form.body,/首次登录必须修改密码/);
  const next='synthetic-changed-password';
  assert.equal((await send('/console/password','POST',{current:initial,password:next,confirm:next,csrf:'wrong'},session)).status,403);
  const changed=await send('/console/password','POST',{current:initial,password:next,confirm:next,csrf:csrf(form.body)},session);
  assert.equal(changed.status,200);assert.match(changed.body,/密码已修改/);
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
  assert.equal((await send('/console/admin/do/password-reset','POST',{csrf:csrf(mine.body),user:server.admin.user.id},memberSession)).status,404);
  const loggedAdmin=await login(testConsoleCredentials(server.admin.token)), adminSession=cookie(loggedAdmin,'circle_hub_session');
  const team=await send(`/console/team/${user.id}`,'GET',undefined,adminSession);assert.match(team.body,/重置密码/);
  assert.match(team.body,/action="\/console\/admin\/do\/password-reset"/);
  const before=await server.records.principals.history(user.id);
  assert.equal((await send('/console/admin/do/password-reset','POST',{csrf:'wrong',user:user.id},adminSession)).status,403);
  assert.equal((await send('/console/admin/do/password-reset','POST',{csrf:csrf(team.body),user:user.id},adminSession,'http://evil.example')).status,403);
  assert.equal((await send('/console/password/reset','POST',{csrf:csrf(team.body),user:user.id},adminSession)).status,404,'the page no longer resets passwords directly');
  assert.equal((await server.records.principals.history(user.id)).length,before.length,'refused forms write no password history');
  const reset=await send('/console/admin/do/password-reset','POST',{csrf:csrf(team.body),user:user.id},adminSession);assert.equal(reset.status,200,reset.body);
  const passwords=[...reset.body.matchAll(/(?:>|\n)([A-Za-z0-9_-]{24})(?=<|\n)/g)].map(match=>match[1]);
  assert.equal(passwords.length,1);const password=passwords[0];assert.match(reset.body,/仅显示一次/);
  assert.doesNotMatch(reset.body,/下面的令牌/);assert.match(reset.body,/href="\/console\/team"/);
  const history=await server.records.principals.history(user.id);
  assert.equal(history.length,before.length+1);assert.equal(history.at(-1)?.changed_by,server.admin.user.id);
  assert.equal(history.at(-1)?.password_changed,true);assert.ok(!JSON.stringify(history).includes(password));
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
test('a valid administrator token and a valid member token are both refused by the console sign-in, with no session',async()=>{
  assert.doesNotMatch((await send('/console/login')).body,/name="token"/,'the sign-in has no token field');
  const admin=await server.createUser('合成令牌管理员','admin'), member=await server.createUser('合成令牌成员');
  for(const user of [admin,member]){
    assert.equal((await server.records.principals.authenticate('Bearer '+user.token))?.id,user.user.id,'the token is valid: it connects a Circle');
    for(const fields of [{token:user.token},{username:user.user.name,password:user.token}] as Record<string,string>[]){
      const refused=await login(fields), what=`${user.user.role}: ${Object.keys(fields).join(' and ')}`;
      assert.equal(refused.status,401,what);
      assert.match(refused.body,/用户名或密码无效，或账号不可用/,what);
      assert.equal(cookie(refused,'circle_hub_session'),'',`${what}: no session`);
    }
    const signed=await login(testConsoleCredentials(user.token));
    assert.equal(signed.status,303);assert.equal(signed.headers.location,'/console/overview','the account signs in with its password');
  }
});
test('only a successful bridged password reset clears the target account login lock',async()=>{
  const initial='synthetic-locked-password';
  const user=await server.records.principals.createUser(server.admin.principal,'合成待解锁账户','user',{password:initial,mustChange:false});
  const other=await server.records.principals.createUser(server.admin.principal,'合成保持锁定账户','user',{password:initial,mustChange:false});
  for(const target of [user,other]){
    for(let i=0;i<5;i++)assert.equal((await login({username:target.name,password:'synthetic-wrong-password'})).status,401);
    assert.equal((await login({username:target.name,password:initial})).status,429);
  }
  const admin=cookie(await login(testConsoleCredentials(server.admin.token)),'circle_hub_session');
  const team=await send(`/console/team/${user.id}`,'GET',undefined,admin);
  assert.equal((await send('/console/admin/do/password-reset','POST',{csrf:'wrong',user:user.id},admin)).status,403);
  assert.equal((await login({username:user.name,password:initial})).status,429,'a refused form does not clear the lock');
  assert.equal((await send('/console/admin/do/password-reset','POST',{csrf:csrf(team.body),user:'usr_00000000000000000000000000'},admin)).status,409);
  assert.equal((await login({username:user.name,password:initial})).status,429,'a failed command does not clear the lock');
  const reset=await send('/console/admin/do/password-reset','POST',{csrf:csrf(team.body),user:user.id},admin);
  assert.equal(reset.status,200,reset.body);
  const password=/(?:>|\n)([A-Za-z0-9_-]{24})(?=<|\n)/.exec(reset.body)?.[1];assert.ok(password);
  const signed=await login({username:user.name,password});
  assert.equal(signed.status,303);assert.match(String(signed.headers.location),/^\/console\/password/);
  assert.equal((await login({username:other.name,password:initial})).status,429,'only the reset account is unlocked');
});
test('an administrator who must change the password signs in with it and can neither read nor reset other accounts first',async()=>{
  const initial='synthetic-admin-initial';
  const admin=await server.records.principals.createUser(server.admin.principal,'合成初始管理员','admin',{password:initial,mustChange:true});
  const signed=await login({username:admin.name,password:initial});assert.match(String(signed.headers.location),/^\/console\/password/);
  const session=cookie(signed,'circle_hub_session');
  assert.equal((await send('/console/api/me','GET',undefined,session)).status,403);
  const form=await send('/console/password','GET',undefined,session);
  assert.equal((await send('/console/admin/do/password-reset','POST',{csrf:csrf(form.body),user:server.admin.user.id},session)).status,303);
});
test('login preserves passwords as typed and accepts the same Unicode username length as account creation',async()=>{
  const name='合成'+'😀'.repeat(70), password=' synthetic Unicode password ';
  await server.records.principals.createUser(server.admin.principal,name,'user',{password,mustChange:false});
  assert.equal((await login({username:name,password:password.trim()})).status,401);
  const signed=await login({username:name,password});
  assert.equal(signed.status,303);assert.equal(signed.headers.location,'/console/overview');
});

test('username failures lock a source for every account and an account from every source, and neither lock reaches the other',async t=>{
  const sessions=new SessionStore();
  let origin='';
  const options:ConsoleOptions={deps:server.deps,sessions,ownOrigins:()=>new Set([origin]),secureRequest:()=>false,
    jobs:new JobStore(),staging:new PackStaging(),log:line=>server.logs.push(line)};
  // Only this fixture substitutes socket addresses; production never trusts a header for the peer's identity.
  const fixture=createServer((req,res)=>{
    Object.defineProperty(req.socket,'remoteAddress',{configurable:true,value:req.headers['x-synthetic-peer']});
    handleConsole(req,res,new URL(req.url!,origin),options).catch(error=>{res.statusCode=500;res.end(String(error));});
  });
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  t.after(()=>new Promise<void>((resolve,reject)=>fixture.close(error=>error?reject(error):resolve())));
  const address=fixture.address();assert.ok(address&&typeof address!=='string');origin=`http://127.0.0.1:${address.port}`;
  const sendPeer=(peer:string,data?:Record<string,string>,nonce=''):Promise<Reply>=>new Promise((resolve,reject)=>{
    const req=request(new URL('/console/login',origin),{method:data?'POST':'GET',agent:false,headers:{origin,'x-synthetic-peer':peer,
      ...(data?{'content-type':'application/x-www-form-urlencoded',cookie:nonce}:{})}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));
    });req.on('error',reject);req.end(data?new URLSearchParams(data).toString():undefined);
  });
  const loginPeer=async(peer:string,fields:Record<string,string>)=>{
    const form=await sendPeer(peer);return sendPeer(peer,{...fields,csrf:csrf(form.body)},cookie(form,'circle_hub_login'));
  };
  const admin={username:server.admin.user.name,password:SYNTHETIC_CONSOLE_PASSWORD};
  // Fifty failures from one source, each for another account, lock that source even for a correct password.
  for(let batch=0;batch<5;batch++){
    const failed=await Promise.all(Array.from({length:10},(_,i)=>loginPeer('192.0.2.10',{username:`合成来源失败账户${batch*10+i}`,password:'invalid'})));
    assert.deepEqual(failed.map(reply=>reply.status),Array(10).fill(401));
  }
  assert.equal((await loginPeer('192.0.2.10',admin)).status,429,'a locked source signs no account in');
  assert.equal((await loginPeer('192.0.2.11',admin)).status,303,'another source still signs the administrator in');
  // Five failures for one account lock it from every source; its source and the other accounts are not locked.
  for(let i=0;i<5;i++)assert.equal((await loginPeer('192.0.2.12',{username:'合成跨来源失败账户',password:'invalid'})).status,401);
  assert.equal((await loginPeer('192.0.2.13',{username:'合成跨来源失败账户',password:'invalid'})).status,429,'switching sources does not bypass an account lock');
  assert.equal((await loginPeer('192.0.2.12',admin)).status,303,'an account lock does not lock its source for another account');
  assert.equal((await loginPeer('192.0.2.13',admin)).status,303,'nor another account on any source');
});
