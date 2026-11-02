// The seven places of the redesigned console (proposal decisions 3 and 6 of 2026-10-31) over HTTP with the fake services:
// every page of an administrator and of a member answers with the side navigation, interface terms only, no style attribute
// and no script; a task's result is derived in one place (display rule 20); the four operations are the only forms; every
// other operation is a command dialog with the real ids; members see only their own Circles and calls.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { TASK_RESULT, uiLabelOf } from '../../contracts/generated/vocabulary.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import type { RunDetail } from '../ports.ts';
import { shellWord } from './console/commands.ts';
import { escapeHtml } from './console/html.ts';
import { CSS } from './console/style.ts';
import { LIVE_SCRIPT } from './console/script.ts';
import { THEME_SCRIPT } from './console/theme.ts';
import { NEUTRAL } from './console/pages.ts';
import { taskResultOf } from './console/status.ts';
import { testConsoleCredentials, createTestServer, type TestServer, type TestUser } from './testing.ts';

let server: TestServer;
let counter = 0;

before(async () => {
  server = await createTestServer();
});
after(async () => {
  await server?.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...options.headers }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const cookieOf = (reply: Reply, name: string): string | undefined => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));
const valueOf = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const csrfOf = (body: string): string => /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
const own = () => `http://127.0.0.1:${server.port}`;

async function signIn(token: string): Promise<string> {
  const page = await send('/console/login');
  const reply = await send('/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: own() },
    body: new URLSearchParams({ ...testConsoleCredentials(token), csrf: csrfOf(page.body) }).toString(),
  });
  assert.equal(reply.status, 303, reply.body);
  assert.equal(reply.headers.location, '/console/overview');
  return `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
}

const get = (path: string, session: string) => send(path, { headers: { cookie: session } });

async function member(packs: string[] = ['review']): Promise<TestUser> {
  counter += 1;
  const user = await server.createUser(`页面成员${counter}`);
  for (const pack of packs) await server.assign(user.principal, pack);
  return user;
}

async function runWithResult(user: TestUser): Promise<string> {
  const client = await server.client(user.token);
  const uploaded = await client.call('upload_file', { file_path: Buffer.from(`合成文档 ${counter}`).toString('base64') });
  const run = await client.call('start_run', { pack: 'review', inputs: { subject: { reference: String(uploaded.structuredContent.reference) } } });
  const summary = run.structuredContent.run as { run: string; items: { id: string }[] };
  await client.call('submit_result', {
    run: summary.run,
    model: 'scripted-model@test',
    items: [
      { item: summary.items[0].id, handling: 'handled', slots: { findings: [{ text: '期望结果缺失' }] } },
      { item: summary.items[1].id, handling: 'handled', slots: { unknown: true } },
    ],
  });
  await client.close();
  return summary.run;
}

/** One console, no style attribute, and only the fixed theme script and optional live module. */
function assertPage(reply: Reply, path: string): void {
  assert.equal(reply.status, 200, `${path}: ${reply.body.slice(0, 300)}`);
  assert.match(String(reply.headers['content-security-policy']), /default-src 'none'/, path);
  assert.doesNotMatch(reply.body.replace(`<script type="module">${LIVE_SCRIPT}</script>`, '').replace(`<script data-console-theme>${THEME_SCRIPT}</script>`, ''), /<script/i, path);
  assert.doesNotMatch(reply.body, /\sstyle=/i, `${path}: a style attribute would be refused by the CSP`);
  assert.match(reply.body, /<nav class="ch-nav" aria-label="主导航">/, path);
  for (const place of ['总览', '任务', '知识库', uiLabelOf('pack_kind', 'workflow'), '连接', '记录', '团队', '设置']) assert.ok(reply.body.includes(`<span>${place}</span>`), `${path}: ${place}`);
  assert.doesNotMatch(reply.body, /你/, `${path}: interface text states facts without a subject`);
}

describe('the eight places', () => {
  test('an administrator opens every place and every operation; the current place is marked', async () => {
    const user = await member();
    const run = await runWithResult(user);
    const admin = await signIn(server.admin.token);
    const pages: Record<string, string> = {
      '/console/overview': '总览', '/console/runs': '任务', [`/console/runs/${run}`]: '任务', '/console/knowledge': '知识库',
      '/console/packs': uiLabelOf('pack_kind', 'workflow'), '/console/packs/review': uiLabelOf('pack_kind', 'workflow'), '/console/connections': '连接', '/console/records': '记录',
      '/console/settings': '设置', '/console/team': '团队', '/console/operations': '设置', '/console/operations/member': '团队', '/console/operations/system': '连接',
      '/console/operations/pack': uiLabelOf('pack_kind', 'workflow'), '/console/operations/knowledge': '知识库', '/console/overview?days=30': '总览',
    };
    for (const [path, place] of Object.entries(pages)) {
      const reply = await get(path, admin);
      assertPage(reply, path);
      assert.match(reply.body, new RegExp(`<a class="ch-nav-item(?: [^"]*)?" href="[^"]+" aria-current="page"><span class="ch-dot" aria-hidden="true"></span><span>${place}</span>`), `${path} marks ${place}`);
    }
    assert.equal((await get('/console', admin)).headers.location, '/console/overview');
  });

  test('a member opens the places, sees no operation and only their own Circles and calls', async () => {
    const user = await member();
    const other = await member();
    await runWithResult(user);
    const otherRun = await runWithResult(other);
    const session = await signIn(user.token);
    for (const path of ['/console/overview', '/console/runs', '/console/knowledge', '/console/packs', '/console/connections', '/console/records', '/console/team', '/console/settings']) assertPage(await get(path, session), path);
    for (const path of ['/console/operations', '/console/operations/member', '/console/admin', '/console/admin/calls']) {
      const refused = await get(path, session);
      assert.equal(refused.status, 404, path);
      assert.ok(refused.body.includes(NEUTRAL), path);
    }
    const records = await get('/console/records', session);
    assert.ok(!records.body.includes(otherRun), 'another member\'s calls are not listed');
    assert.ok(!records.body.includes('管理员备注'));
    const settings = await get('/console/settings', session);
    assert.ok(settings.body.includes('我的 Circle'));
    assert.ok(!settings.body.includes('circle-hub user disable'), 'no command for an administrator\'s operation');
    const overview = await get('/console/overview', session);
    assert.ok(!overview.body.includes('添加成员'), 'no management entry for a member');
  });
});

describe('tasks', () => {
  test('the list filters by task result, the detail shows the execution process above the full record', async () => {
    const user = await member();
    const run = await runWithResult(user);
    const session = await signIn(user.token);
    const list = await get('/console/runs', session);
    assert.ok(list.body.includes(run));
    const result = taskResultOf((await server.deps.runs.getRun(user.principal, run))!);
    assert.ok(list.body.includes(uiLabelOf('task_result', result)), 'the result of the task');
    const filtered = await get(`/console/runs?result=${result}`, session);
    assert.ok(filtered.body.includes(run));
    const other = TASK_RESULT.find((r) => r !== result)!;
    assert.ok(!(await get(`/console/runs?result=${other}`, session)).body.includes(`/console/runs/${run}"`), 'another result filters it out');
    assert.equal((await get('/console/runs?result=bogus', session)).status, 400);
    const detail = await get(`/console/runs/${run}`, session);
    for (const text of ['执行过程', '工具调用', 'Hub 校验', '任务结果', '完整记录', '提交结果', '启动任务']) assert.ok(detail.body.includes(text), text);
    assert.ok(detail.body.indexOf('执行过程') < detail.body.indexOf('完整记录'), 'the process comes first');
    assert.match(detail.body, /<svg class="svg-track" role="img"/, 'bars are SVG attributes');
  });

  test('a task result follows display rule 20: held, incomplete and rejected first, unknown never passed', () => {
    const requirement = (status: 'satisfied' | 'pending' | 'unsatisfied', terminal: 'pass' | 'unchecked' | 'violation' = 'pass') => ({ requirement: 'r', layers: [{ layer: 'static' as const, terminal }], status, ...(status === 'unsatisfied' ? { unsatisfied_reason: 'outcome_mismatch' as const } : {}), claims: [] });
    const item = (id: string, r = requirement('satisfied')) => ({ item: id, label: id, location: 'src:x', requirements: [r] });
    const detail = (partitions: Partial<ValidationResult['partitions']>, acceptance: 'accepted' | 'not_accepted' = 'accepted'): RunDetail => ({
      run: { run: 'run_x', requirements: [{ key: 'r', accepted_producer: 'judgment' }] },
      submissions: [], production: null,
      latest: { record: 'r'.repeat(64), result: { acceptance, cross_item: [], partitions: { delivered: [], rejected: [], quarantined: [], incomplete: [], ...partitions } } },
    } as unknown as RunDetail);
    assert.equal(taskResultOf(detail({ delivered: [item('a')] })), 'passed');
    assert.equal(taskResultOf(detail({ delivered: [item('a'), item('b', requirement('pending'))] })), 'delivered_pending');
    assert.equal(taskResultOf(detail({ delivered: [item('a', requirement('satisfied', 'unchecked'))] })), 'delivered_pending', 'an unknown terminal is never passed');
    assert.equal(taskResultOf(detail({ delivered: [item('a', requirement('unsatisfied', 'violation'))] })), 'delivered_unsatisfied');
    assert.equal(taskResultOf(detail({ delivered: [item('a')], rejected: [{ ...item('b'), code: 'x' }] as never })), 'rejected');
    assert.equal(taskResultOf(detail({ rejected: [{ ...item('b'), code: 'x' }] as never, incomplete: [{ ...item('c'), reason: 'not_covered' }] as never })), 'incomplete');
    assert.equal(taskResultOf(detail({ incomplete: [{ ...item('c'), reason: 'not_covered' }] as never, quarantined: [{ ...item('d'), reason: 'integrity_unproven' }] as never })), 'held');
    assert.equal(taskResultOf(detail({}, 'not_accepted')), 'awaiting');
    assert.equal(taskResultOf({ ...detail({ delivered: [item('a')] }), latest: null }), 'awaiting');
    assert.equal(taskResultOf({ ...detail({ delivered: [item('a')] }), management: { record: 'm'.repeat(64), disposition: 'abandon', result: null } }), 'abandoned');
  });
});

describe('operations and commands', () => {
  test('publication titles and form routes follow the kind without granting members administration', async () => {
    const admin=await signIn(server.admin.token);
    for(const kind of ['workflow','skill','product','system'] as const){
      const operation=await get('/console/operations/pack?kind='+kind,admin);
      assert.equal(operation.status,200);assert.match(operation.body,new RegExp('<h1[^>]*><span[^>]*>发布'+uiLabelOf('pack_kind',kind)+'<span'));
      const action='/console/admin/do/pack-stage'+(kind==='workflow'?'':'?kind='+kind);
      assert.ok(operation.body.includes(`action="${action}"`));
    }
    assert.ok((await get('/console/knowledge',admin)).body.includes('href="/console/operations/pack?kind=product"'));
    assert.ok((await get('/console/connections',admin)).body.includes('href="/console/operations/pack?kind=system"'));
    const user=await member(), session=await signIn(user.token);
    assert.equal((await get('/console/operations/pack?kind=system',session)).status,404);
    const invalid=await get('/console/operations/pack?kind=__proto__',admin);
    assert.match(invalid.body,new RegExp('<h1[^>]*><span[^>]*>发布'+uiLabelOf('pack_kind','workflow')+'<span'));
  });

  test('product and system integrations appear in their own places and details retain catalog permissions', async () => {
    const admin=await signIn(server.admin.token);
    const knowledge=await get('/console/knowledge',admin), connections=await get('/console/connections',admin);
    assert.match(knowledge.body,/id="product-sources"/);assert.match(knowledge.body,/href="\/console\/packs\/line-a"/);
    assert.ok(knowledge.body.includes(uiLabelOf('pack_kind','product')));assert.match(knowledge.body,/合成产品线（line-a）/);
    assert.match(connections.body,/id="system-sources"/);assert.match(connections.body,/href="\/console\/packs\/tracker-system"/);
    assert.ok(connections.body.includes(uiLabelOf('pack_kind','system')));assert.match(connections.body,/合成跟踪系统/);
    for(const [id,place,kind] of [['line-a','知识库','product'],['tracker-system','连接','system']] as const){
      const detail=await get('/console/packs/'+id,admin);
      assert.equal(detail.status,200);assert.match(detail.body,new RegExp(`>${place}</a> › <a[^>]*>${uiLabelOf('pack_kind',kind)}</a> ›`));
      const user=await member(), session=await signIn(user.token);
      assert.equal((await get('/console/packs/'+id,session)).status,404);
    }
    const user=await member(), session=await signIn(user.token), mine=await get('/console/knowledge',session);
    assert.doesNotMatch(mine.body,/href="\/console\/packs\/line-a"/,'moving source configuration does not grant new catalog access');
    assert.ok(mine.body.includes('合成产品线'),'existing product-line knowledge remains readable');
  });

  test('unavailable source metadata stays unknown while retired and inactive catalog states remain visible', async t => {
    const sources = [
      { id: 'synthetic-unknown-product', version: '1.0.0', kind: 'product' as const, title: '合成未启用来源', description: '合成说明', digest: 'c'.repeat(64), owner: null, summary: null, active: false },
      { id: 'synthetic-unused-system', version: '1.0.0', kind: 'system' as const, title: '合成退役接入', description: '合成说明', digest: 'd'.repeat(64), owner: null, summary: null, withdrawn: true },
    ];
    const catalog = server.deps.packs, list = catalog.list;
    catalog.list = async principal => (await list.call(catalog, principal)).map(pack => ({ ...pack,
      ...(pack.id === sources[0].id ? { active: false } : {}),
      ...(pack.id === sources[1].id ? { withdrawn: true } : {}),
    }));
    t.after(() => { catalog.list = list; });
    server.fakes.workflows.packs.push(...sources);
    t.after(() => { for (const source of sources) server.fakes.workflows.packs.splice(server.fakes.workflows.packs.indexOf(source), 1); });
    const admin = await signIn(server.admin.token);
    for (const [path, source, state] of [['/console/knowledge', sources[0], 'inactive'], ['/console/connections', sources[1], 'retired']] as const) {
      const body = (await get(path, admin)).body;
      const row = [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].find(match => match[0].includes('/console/packs/' + source.id))?.[0];
      assert.ok(row);
      assert.ok(row.includes(uiLabelOf('pack_status', state)));
      assert.match(row, /<td>—<\/td>/, 'no product line or business system is invented');
    }
  });

  test('workflows and generic skills have separate columns and acceptance stays above detail controls without a node graph', async t => {
    const skill={id:'synthetic-skill',version:'1.0.0',kind:'skill' as const,title:'合成通用技能',description:'合成说明',digest:'f'.repeat(64),owner:null,summary:null};
    server.fakes.workflows.packs.push(skill);
    t.after(()=>{server.fakes.workflows.packs.splice(server.fakes.workflows.packs.indexOf(skill),1);});
    const admin=await signIn(server.admin.token), list=await get('/console/packs',admin);
    assert.equal(list.status,200);assert.match(list.body,/class="grid g2 section"/);
    const workflow=/<section class="stack" aria-label="工作流" id="team-workflow">([\s\S]*?)<\/section>/.exec(list.body)?.[1];
    const skills=/<section class="stack" aria-label="通用技能" id="team-skill">([\s\S]*?)<\/section>/.exec(list.body)?.[1];
    assert.ok(workflow&&skills);assert.match(workflow,/href="\/console\/packs\/review"/);
    assert.ok(!workflow.includes(skill.title));assert.ok(skills.includes(skill.title));
    assert.match(workflow,/title="规定做法与验收要求；由 Circle 执行，Hub 按验收要求判定结果"/);
    assert.match(skills,/title="只规定做法，没有验收要求"/);
    assert.doesNotMatch(list.body,/href="\/console\/packs\/(?:line-a|tracker-system)"/);
    const detail=await get('/console/packs/review',admin);
    assert.ok(detail.body.indexOf('验收要求')<detail.body.indexOf('版本与权限'));
    assert.match(detail.body,/结构/);assert.doesNotMatch(detail.body,/class="stages"/);
    const memberSession=await signIn((await member()).token), mine=await get('/console/packs',memberSession);
    assert.ok(!mine.body.includes(skill.title));
  });

  test('Circle tables show registered device names or direct-token labels without token identifiers', async () => {
    const user=await member();
    const client=await server.records.principals.registerClient('合成 MacBook Circle',['http://127.0.0.1/callback']);
    const oauth=await server.records.principals.issueToken(server.admin.principal,user.user.id,'不应替代客户端名称',client.id);
    const direct=await server.records.principals.issueToken(server.admin.principal,user.user.id,'合成 Linux Circle');
    const admin=await signIn(server.admin.token), memberSession=await signIn(user.token);
    for(const path of ['/console/team',`/console/team/${user.user.id}`,'/console/connections']) {
      const reply=await get(path,admin);
      const tables=[...reply.body.matchAll(/<table[\s\S]*?<\/table>/g)].map(match=>match[0]).join('');
      assert.match(tables,/设备名/);
      assert.match(tables,/合成 MacBook Circle/);
      assert.match(tables,/合成 Linux Circle/);
      const visible=tables.replace(/<[^>]*>/g,'');
      assert.ok(!visible.includes(oauth.id)&&!visible.includes(direct.id));
      assert.ok(reply.body.includes(`circle-hub token revoke ${oauth.id}`),'disconnect command retains its exact target');
    }
    const mine=await get('/console/settings',memberSession);
    assert.match(mine.body,/合成 MacBook Circle/);
    assert.ok(!mine.body.includes(oauth.id)&&!mine.body.includes(direct.id));
  });
  test('team owns members and permissions, settings retains system settings and members cannot browse another account', async () => {
    const user=await member(), other=await member();
    const admin=await signIn(server.admin.token), session=await signIn(user.token);
    const team=await get('/console/team',admin);
    assert.ok(team.body.includes(`/console/team/${user.user.id}`));
    assert.ok(team.body.indexOf('href="/console/team"')<team.body.indexOf('href="/console/settings"'));
    assert.match(team.body,/第一个账户是管理员/);
    assert.match(team.body,/添加成员/);
    const settings=await get('/console/settings',admin);
    assert.doesNotMatch(settings.body,/添加成员|circle-hub user disable|id="people"/);
    const detail=await get(`/console/team/${user.user.id}`,admin);
    assert.match(detail.body,/成员详情|权限|工作流分配|已连接的 Circle/);
    assert.ok(detail.body.includes(`circle-hub pack unassign ${user.user.id} review`));
    assert.equal((await get(`/console/team/${other.user.id}`,session)).status,404);
    assert.equal((await get('/console/team/absent',admin)).status,404);
    const mine=await get('/console/team',session);
    assert.ok(mine.body.includes(user.user.name));
    assert.ok(!mine.body.includes(other.user.name));
    assert.doesNotMatch(mine.body,/添加成员|circle-hub user disable/);
    assert.ok(team.body.includes(uiLabelOf('account_status','enabled')));
    assert.doesNotMatch(team.body,/使用中/);
    await server.records.principals.setDisabled(server.admin.principal,other.user.id,true);
    const disabled=await get(`/console/team/${other.user.id}`,admin);
    assert.ok(disabled.body.includes(uiLabelOf('account_status','disabled')));
    assert.doesNotMatch(disabled.body,/使用中/);
  });
  test('settings, connections and packs offer the other operations as commands with the real ids, never as forms', async () => {
    const user = await member();
    const admin = await signIn(server.admin.token);
    const settings = await get('/console/team', admin);
    const [token] = await server.records.principals.tokens(user.user.id);
    for (const command of [`circle-hub user disable ${user.user.id}`, `circle-hub token revoke ${token.id}`, `circle-hub token issue ${user.user.id} --label=Circle`]) assert.ok(settings.body.includes(escapeHtml(command)), command);
    assert.match(settings.body, /<div class="modal" id="cmd-user-disable-[^"]+" role="dialog"/);
    assert.match(settings.body, /href="#cmd-user-disable-[^"]+"/, 'the button opens its dialog by fragment');
    assert.doesNotMatch(settings.body, /action="\/console\/admin\/do\/(?!member-add)/, 'no management form on the settings page');
    const connections = await get('/console/connections', admin);
    const [resource] = await server.deps.resources.list(server.admin.principal);
    assert.ok(connections.body.includes(`circle-hub resource disable ${resource.id}`) || connections.body.includes(`circle-hub resource enable ${resource.id}`));
    assert.ok(connections.body.includes('这个 Hub 进程未接入派发'), 'no runtime environments without the dispatch port');
    const pack = await get('/console/packs/review', admin);
    assert.ok(pack.body.includes('circle-hub pack retire review@1.0.0'));
    assert.ok(pack.body.includes('要求项') && pack.body.includes('检查项'));
    for (const path of ['/console/packs/absent', '/console/packs/__proto__', '/console/operations/backup']) assert.equal((await get(path, admin)).status, 404, path);
    assert.match(CSS, /\.modal:target\{/);
  });

  test('a command word that is not an identifier is quoted for the shell', () => {
    assert.equal(shellWord('usr_0123456789abcdefghjkmnpqrs'), 'usr_0123456789abcdefghjkmnpqrs');
    assert.equal(shellWord('review@1.0.0'), 'review@1.0.0');
    assert.equal(shellWord("a b'c"), `'a b'\\''c'`);
    assert.equal(shellWord('--reason=请填写理由'), `'--reason=请填写理由'`);
  });
});

describe('sign-in states', () => {
  test('a session whose password was reset returns to the login page, which says the sign-in ended once', async () => {
    const user = await member();
    const session = await signIn(user.token);
    await server.records.principals.resetPassword(server.admin.principal,user.user.id);
    const ended = await get('/console/runs', session);
    assert.equal(ended.status, 303);
    assert.equal(ended.headers.location, '/console/login?next=%2Fconsole%2Fruns', 'signing in again leads back to the page');
    const flag = cookieOf(ended, 'circle_hub_ended');
    assert.match(flag ?? '', /^circle_hub_ended=1; Path=\/console\/login; HttpOnly; SameSite=Strict; Max-Age=120$/);
    const login = await send('/console/login', { headers: { cookie: `circle_hub_ended=1` } });
    assert.match(login.body, /登录已过期或已退出/);
    assert.match(cookieOf(login, 'circle_hub_ended') ?? '', /Max-Age=0/, 'said once');
    assert.doesNotMatch((await send('/console/login')).body, /登录已过期或已退出/);
  });
});
