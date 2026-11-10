import { ACCEPTED_PRODUCER_NOTE, DONE_RULE_NOTE } from './console/pack-display.ts';
import {withoutNonces} from './console/testing-security.ts';
import {THEME_TAGS,LIVE_TAG} from './console/html.ts';
// The seven places of the redesigned console (proposal decisions 3 and 6 of 2026-10-31) over HTTP with the fake services:
// every page of an administrator and of a member answers with the side navigation, interface terms only, no style attribute
// and no script; a task's result is derived in one place (display rule 20); the four operations are the only forms; every
// other operation is a command dialog with the real ids; members see only their own Circles and calls.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {parse} from 'parse5';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { TASK_RESULT, uiLabelOf } from '../../contracts/generated/vocabulary.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import type { RunDetail } from '../ports.ts';
import { shellWord } from './console/commands.ts';
import { escapeHtml } from './console/html.ts';
import { CSS } from './console/style.ts';
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
  assert.doesNotMatch(withoutNonces(reply.body).replace(LIVE_TAG, '').replace(THEME_TAGS, ''), /<script/i, path);
  assert.doesNotMatch(reply.body, /\sstyle=/i, `${path}: a style attribute would be refused by the CSP`);
  assert.match(reply.body, /<nav class="ch-nav" aria-label="主导航">/, path);
  for (const place of ['总览', '任务', '知识库', uiLabelOf('pack_kind', 'workflow'), '连接', '记录', '团队', '设置']) assert.ok(reply.body.includes(`<span>${place}</span>`), `${path}: ${place}`);
  const visit=(node:any,inRow=false):void=>{const cls=node.attrs?.find((attr:any)=>attr.name==='class')?.value?.split(' ')??[];const row=inRow||node.nodeName==='tr'||cls.includes('ch-row');if(row)assert.ok(!['button','form'].includes(node.nodeName)&&!cls.includes('ch-btn'),path+': rows carry no actions');for(const child of node.childNodes??[])visit(child,row);};visit(parse(reply.body));
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
    assert.ok(settings.body.includes('我的客户端'));
    assert.ok(!settings.body.includes('circle-hub user disable'), 'no command for an administrator\'s operation');
    const overview = await get('/console/overview', session);
    assert.ok(!overview.body.includes('添加成员'), 'no management entry for a member');
  });
});

describe('tasks', () => {
  test('the list filters by task result, the detail opens with the result and keeps the rest in tabs', async () => {
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
    // Decision 151: the page opens with the result and what still waits for someone; the rest is one of six tabs.
    const detail = await get(`/console/runs/${run}`, session);
    const outcome = detail.body.indexOf('data-task-outcome');
    assert.ok(outcome >= 0, 'the page has a result block');
    assert.ok(outcome < detail.body.indexOf('data-task-tabs'), 'the result comes before the tabs');
    for (const text of ['任务结果', '还需处理', '验收要求', '条目', '请求', '过程', '来源', '技术信息']) assert.ok(detail.body.includes(text), text);
    assert.match(detail.body, /data-task-tab="requirements"/);
    assert.doesNotMatch(detail.body, /data-timeline|<aside class="ch-inspector"/, 'the first tab draws no process and the page has no side pane');
    const process = await get(`/console/runs/${run}?tab=process`, session);
    for (const text of ['执行过程', '工具调用', 'Hub 校验', '提交结果', '启动任务', '提交与回执', '调用日志']) assert.ok(process.body.includes(text), text);
    assert.match(process.body, /<svg class="ch-chart" data-timeline/, 'bars are SVG attributes');
    assert.ok(process.body.indexOf('data-task-outcome') < process.body.indexOf('data-timeline'), 'the result stays above every tab');
    assert.match(process.body, /<a href="\/console\/runs\/[^"]+\?tab=process" aria-current="page">过程/);
    const items = await get(`/console/runs/${run}?tab=items`, session);
    assert.equal((items.body.match(/id="task-evidence"/g) ?? []).length, 1, 'one evidence section, in the 条目 tab');
    // The old address of the full record opens the technical information.
    assert.match((await get(`/console/runs/${run}?view=record`, session)).body, /data-task-tab="record"/);
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
    const knowledge=await get('/console/knowledge',admin), connections=await get('/console/connections?tab=packs',admin);
    assert.match(knowledge.body,/id="product-sources"/);assert.match(knowledge.body,/href="\/console\/packs\/line-a"/);
    assert.ok(knowledge.body.includes(uiLabelOf('pack_kind','product')));assert.match(knowledge.body,/合成产品线/);
    assert.match(connections.body,/id="live-system-sources"/);assert.match(connections.body,/href="\/console\/packs\/tracker-system"/);
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
    for (const [path, source, state] of [['/console/knowledge', sources[0], 'inactive'], ['/console/connections?tab=packs', sources[1], 'retired']] as const) {
      const body = (await get(path, admin)).body;
      const row = [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].find(match => match[0].includes('/console/packs/' + source.id))?.[0];
      assert.ok(row);
      assert.ok(row.includes(uiLabelOf('pack_status', state)));
      assert.match(row, /<td>—<\/td>/, 'no product line or business system is invented');
    }
  });

  test('workflows and skills have separate places, and acceptance stays above detail controls without a node graph', async t => {
    const skill={id:'synthetic-skill',version:'1.0.0',kind:'skill' as const,title:'合成通用技能',description:'合成说明',digest:'f'.repeat(64),owner:null,summary:null};
    server.fakes.workflows.packs.push(skill);
    t.after(()=>{server.fakes.workflows.packs.splice(server.fakes.workflows.packs.indexOf(skill),1);});
    const admin=await signIn(server.admin.token), list=await get('/console/packs',admin);
    assert.equal(list.status,200);
    // Decision 151, step 6: the place is one table; under 全部 a column says whose each row is.
    const workflow=/<section class="ch-section" id="workflow" aria-label="工作流"[^>]*>([\s\S]*?)<\/section>/.exec(list.body)?.[1];
    assert.ok(workflow);assert.match(workflow,/<table class="ch-table" data-view="packs">/);assert.match(workflow,/href="\/console\/packs\/review\?scope=all"/);assert.match(workflow,/data-pack-scope="team"/);
    assert.doesNotMatch(list.body,/class="ch-empty"/,'a group with nothing in it takes no room');
    // Decision 151: the workflows place lists workflows only; skills have their own place.
    assert.doesNotMatch(list.body,/id="skill"/);assert.ok(!list.body.includes(skill.title));
    assert.match(list.body,/<a class="ch-nav-item[^"]*" href="\/console\/packs" aria-current="page">/);
    const skills=await get('/console/skills',admin);
    assert.equal(skills.status,200);
    const group=/<section class="ch-section" id="skill" aria-label="通用技能"[^>]*>([\s\S]*?)<\/section>/.exec(skills.body)?.[1];
    assert.ok(group);assert.ok(group.includes(skill.title));assert.match(group,/href="\/console\/skills\/synthetic-skill\?scope=all"/);
    assert.doesNotMatch(skills.body,/id="workflow"/);assert.doesNotMatch(skills.body,/href="\/console\/packs\/review/);
    assert.match(skills.body,/<a class="ch-nav-item[^"]*" href="\/console\/skills" aria-current="page">/);
    assert.match(skills.body,/<h1 class="ch-title">[\s\S]*?技能/);
    // What each kind is for is the hint of its place's title: one place, one kind, one purpose.
    assert.match(list.body,/要完成一项有验收要求的任务，选择工作流/);assert.doesNotMatch(list.body,/要让客户端遵循一套通用做法/);
    assert.match(skills.body,/要让客户端遵循一套通用做法，选择通用技能；技能不设验收要求/);assert.doesNotMatch(skills.body,/要完成一项有验收要求的任务/);
    assert.doesNotMatch(workflow,/title="规定做法与验收要求/);
    assert.doesNotMatch(list.body,/href="\/console\/packs\/(?:line-a|tracker-system)"/);
    // A skill's page answers under either path and stands in the skills place; its trail does not repeat the kind.
    for(const path of ['/console/skills/synthetic-skill','/console/packs/synthetic-skill']){
      const page=await get(path,admin);assert.equal(page.status,200,path);
      assert.match(page.body,/<a class="ch-nav-item[^"]*" href="\/console\/skills" aria-current="page">/,path);
      assert.match(page.body,/<nav class="ch-crumbs" aria-label="位置"><a href="\/console\/skills">技能<\/a> › 合成通用技能<\/nav>/,path);
    }
    const detail=await get('/console/packs/review',admin);
    assert.match(detail.body,/<a class="ch-nav-item[^"]*" href="\/console\/packs" aria-current="page">/);
    assert.ok(detail.body.indexOf('验收要求')<detail.body.indexOf('版本记录'));
    // A pack is a page of its own: its name is the title, no pane stands beside it, and its content is in tabs.
    assert.match(detail.body,/<h1 class="ch-title">[\s\S]*?合成评审/);assert.doesNotMatch(detail.body,/<aside class="ch-inspector"/);
    assert.deepEqual([...(/<nav class="ch-seg" aria-label="工作流内容" data-pack-tabs>([\s\S]*?)<\/nav>/.exec(detail.body)?.[1]??'').matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)/g)].map(match=>[match[1],!!match[2],match[3].trim()]),
      [['/console/packs/review',true,'验收要求'],['/console/packs/review?tab=checks',false,'检查项'],['/console/packs/review?tab=versions',false,'版本记录'],['/console/packs/review?tab=technical',false,'技术信息']]);
    // Identifiers, digests and version numbers stand on the last tab only.
    assert.doesNotMatch(detail.body,/review@1\.0\.0<\/code>|内容哈希/);
    const technical=await get('/console/packs/review?tab=technical',admin);assert.match(technical.body,/<code>review@1\.0\.0<\/code>/);assert.match(technical.body,/内容哈希/);
    const history=await get('/console/packs/review?tab=versions',admin);assert.match(history.body,/当前显示/);assert.doesNotMatch(history.body,/这里显示的是较早的版本/);
    const skillPage=await get('/console/skills/synthetic-skill',admin);
    assert.deepEqual([...(/<nav class="ch-seg" aria-label="通用技能内容" data-pack-tabs>([\s\S]*?)<\/nav>/.exec(skillPage.body)?.[1]??'').matchAll(/<a href="[^"]+"(?: aria-current="page")?>([^<]+)/g)].map(match=>match[1].trim()),['版本记录','技术信息'],'a skill declares no acceptance');
    // Issue 229: the abstract column heads of the requirement table say what they mean.
    assert.ok(detail.body.includes(DONE_RULE_NOTE)&&detail.body.includes(ACCEPTED_PRODUCER_NOTE),'the workflow page explains the delivery rule and the accepted producer');
    assert.match(detail.body,/结构/);assert.doesNotMatch(detail.body,/class="stages"/);
    const memberSession=await signIn((await member()).token);
    for(const path of ['/console/packs','/console/skills'])assert.ok(!(await get(path,memberSession)).body.includes(skill.title),path);
  });

  test('client tables show registered client names or direct-token labels without token identifiers', async () => {
    const user=await member();
    const client=await server.records.principals.registerClient('合成 MacBook Circle',['http://127.0.0.1/callback']);
    const oauth=await server.records.principals.issueToken(server.admin.principal,user.user.id,'不应替代客户端名称',client.id);
    const direct=await server.records.principals.issueToken(server.admin.principal,user.user.id,'合成 Linux Circle');
    const admin=await signIn(server.admin.token), memberSession=await signIn(user.token);
    for(const path of ['/console/team',`/console/team/${user.user.id}`,'/console/connections']) {
      const reply=await get(path==='/console/connections'?path+'?tab=clients':path,admin);
      const tables=[...reply.body.matchAll(/<table[\s\S]*?<\/table>/g)].map(match=>match[0]).join('');
      assert.match(tables,/<th scope="col">客户端<\/th>[\s\S]*<th scope="col">连接方式<\/th>/);
      assert.match(tables,/合成 MacBook Circle/);
      assert.match(tables,/合成 Linux Circle/);
      const visible=tables.replace(/<[^>]*>/g,'');
      assert.ok(!visible.includes(oauth.id)&&!visible.includes(direct.id));
      assert.doesNotMatch(tables,/<button|ch-btn|<form/);
      const selected=await get((path.startsWith('/console/team')?'/console/team':'/console/connections')+'?circle='+oauth.id,admin);
      assert.ok(selected.body.includes(`circle-hub token revoke ${oauth.id}`),'disconnect command retains its exact target after selection');
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
    // Decision 151, step 8: 凭据 and Hub 状态 are two addresses, no longer two anchors of one page with the first always marked.
    assert.match(settings.body,/<nav class="ch-seg" aria-label="设置内容" data-settings-tabs><a href="\/console\/settings" aria-current="page">凭据/);
    assert.match(settings.body,/id="secrets"/);assert.doesNotMatch(settings.body,/data-hub-state|主机操作/);
    const hubTab=await get('/console/settings?tab=hub',admin);
    assert.match(hubTab.body,/<a href="\/console\/settings\?tab=hub" aria-current="page">Hub 状态<\/a>/);assert.doesNotMatch(hubTab.body,/<a href="\/console\/settings" aria-current="page">/);
    assert.match(hubTab.body,/data-hub-state/);assert.match(hubTab.body,/主机操作/);assert.doesNotMatch(hubTab.body,/id="secrets"/);
    const memberHub=await get('/console/settings?tab=hub',session);
    assert.match(memberHub.body,/data-hub-state/);assert.doesNotMatch(memberHub.body,/主机操作|备份命令|id="mine"/);
    assert.match((await get('/console/settings',session)).body,/<a href="\/console\/settings" aria-current="page">我的客户端/);
    const detail=await get(`/console/team/${user.user.id}?workflow=review`,admin);
    assert.match(detail.body,/成员详情|权限|工作流分配|已连接的客户端/);
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
    const settings = await get('/console/team/'+user.user.id, admin);
    const [token] = await server.records.principals.tokens(user.user.id);
    for (const command of [`circle-hub user disable ${user.user.id}`, `circle-hub token issue ${user.user.id} '--label=客户端'`]) assert.ok(settings.body.includes(escapeHtml(command)), command);
    assert.match(settings.body, /<div class="ch-dialog" id="cmd-user-disable-[^"]+" role="dialog"/);
    assert.match(settings.body, /href="#cmd-user-disable-[^"]+"/, 'the button opens its dialog by fragment');
    assert.doesNotMatch(settings.body, /action="\/console\/admin\/do\/(?:user-disable|token-revoke|token-issue)/, 'these management actions remain command dialogs');
    const [resource] = await server.deps.resources.list(server.admin.principal);
    const connections = await get('/console/connections?system='+resource.id, admin);
    const circle = await get('/console/team?circle='+token.id,admin);
    assert.ok(circle.body.includes(`circle-hub token revoke ${token.id}`));
    assert.ok(connections.body.includes(`circle-hub resource disable ${resource.id}`) || connections.body.includes(`circle-hub resource enable ${resource.id}`));
    assert.ok((await get('/console/connections?tab=environments', admin)).body.includes('这个 Hub 进程未接入派发'), 'no runtime environments without the dispatch port');
    const pack = await get('/console/packs/review', admin);
    assert.ok(pack.body.includes('circle-hub pack retire review@1.0.0'));
    assert.ok(pack.body.includes('要求项') && pack.body.includes('检查项'));
    for (const path of ['/console/packs/absent', '/console/packs/__proto__', '/console/operations/backup']) assert.equal((await get(path, admin)).status, 404, path);
    assert.match(CSS, /\.ch-dialog:target/);
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

test('contextual system and call inspectors only select rows in the authorized projection and retain filter URLs',async()=>{
 const author=await member(),stranger=await member([]),admin=await signIn(server.admin.token),other=await signIn(stranger.token);
 const run=await runWithResult(author),calls=await server.records.callLog.query(author.principal,{runId:run,limit:100});
 const call=calls.items[0];assert.ok(call);
 const records=await get('/console/records?'+new URLSearchParams({run,call:call.digest}),admin);
 assert.equal(records.status,200);assert.match(records.body,/aria-label="详情"/);assert.match(records.body,/class="is-selected" aria-selected="true"/);
 assert.ok(records.body.includes('run='+run+'&amp;call='));assert.match(records.body,/返回记录/);
 const hidden=await get('/console/records?call='+call.digest,other),missing=await get('/console/records?call='+'0'.repeat(64),other);
 assert.equal(hidden.status,404);assert.equal(withoutNonces(hidden.body),withoutNonces(missing.body));
 const [resource]=await server.deps.resources.list(server.admin.principal);
 assert.equal((await get('/console/connections?system='+encodeURIComponent(resource.id),admin)).status,200);
 const refused=await get('/console/connections?system='+encodeURIComponent(resource.id),other),absent=await get('/console/connections?system=synthetic-missing',other);
 assert.equal(refused.status,404);assert.equal(withoutNonces(refused.body),withoutNonces(absent.body));
 const complete=await get('/console/runs/'+run+'?view=record',await signIn(author.token));
 assert.match(complete.body,/data-without-inspector/);assert.match(complete.body,/data-task-tab="record"/);assert.match(complete.body,/技术信息/);assert.doesNotMatch(complete.body,/class="ch-app[^\"]*is-detail/);
});

test('the overview uses a Stat and thin parts bar with labelled counts instead of a donut and no area renders placeholder inspector facts',async()=>{
 const session=await signIn(server.admin.token),overview=await get('/console/overview',session);
 assert.match(overview.body,/检查项结果/);assert.match(overview.body,/class="ch-stat-value"/);assert.match(overview.body,/class="ch-parts"/);assert.doesNotMatch(overview.body,/donut|donut-hold/);
 for(const area of ['overview','runs','connections','records','team','settings']){
  const page=await get('/console/'+area,session);assert.equal(page.status,200);assert.doesNotMatch(page.body,/当前页面|当前账号/);
  // Decision 151: no place repeats itself in a summary pane; a pane opens only for a selected thing.
  assert.doesNotMatch(page.body,/aria-label="概况"|<aside class="ch-inspector"/,area);
  // A dialog on the page is one something on the page opens: none is left behind without a link to it.
  for(const dialog of page.body.matchAll(/<div class="ch-dialog" id="([^"]+)"/g))assert.ok(page.body.includes('href="#'+dialog[1]+'"'),area+' links to its dialog '+dialog[1]);
 }
});


test('member and Circle selection moves exact administrative targets to danger confirmation dialogs without executing them',async()=>{
 const user=await member(),other=await member(),admin=await signIn(server.admin.token),mine=await signIn(user.token);
 const [token]=await server.records.principals.tokens(other.user.id);
 const root=await get('/console/team',admin);assert.doesNotMatch(root.body,/circle-hub user disable|circle-hub token revoke/);
 const selected=await get('/console/team/'+other.user.id,admin);assert.match(selected.body,/aria-selected="true"/);assert.match(selected.body,/class="ch-btn ch-btn--danger" href="#cmd-user-disable-/);
 const circle=await get('/console/team?circle='+token.id,admin);assert.match(circle.body,/class="ch-btn ch-btn--danger" href="#cmd-token-revoke-/);assert.ok(circle.body.includes('circle-hub token revoke '+token.id));
 assert.equal((await server.records.principals.get(other.user.id))?.disabled,false);assert.equal((await server.records.principals.tokens(other.user.id)).find(t=>t.id===token.id)?.revoked_at,null);
 for(const path of ['/console/team','/console/connections']){const hidden=await get(path+'?circle='+token.id,mine),absent=await get(path+'?circle=synthetic-missing',mine);assert.equal(hidden.status,404);assert.equal(withoutNonces(hidden.body),withoutNonces(absent.body));}
});

test('record periods constrain the list and chart together, and an unresolved member never contributes other accounts to statistics',async t=>{
 const user=await member(),admin=await signIn(server.admin.token),now=Date.now();
 const put=(at:number,tool:string)=>server.records.callLog.append({at:new Date(at).toISOString(),traceId:randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),userId:user.user.id,sessionId:null,tool,runId:null,arguments:{},callResult:'ok',durationMs:1});
 const recent=await put(now-1000,'initialize'),old=await put(now-20*86400000,'list_task_packs');
 const base='/console/records?user='+encodeURIComponent(user.user.name);
 const seven=await get(base+'&days=7',admin),thirty=await get(base+'&days=30',admin);assert.equal(seven.status,200);assert.ok(seven.body.includes(recent.digest));assert.ok(!seven.body.includes(old.digest));assert.ok(thirty.body.includes(old.digest));
 // Decision 151: the call list and the charts are two tabs of the same period and filters.
 assert.doesNotMatch(seven.body,/<figure/);const charts=(await get(base+'&days=7&tab=stats',admin)).body;assert.ok(!charts.includes(recent.digest),'the statistics tab lists no call');
 const chart=charts.slice(charts.indexOf('<figure'),charts.indexOf('</figure>'));assert.match(chart,/其他/);assert.match(chart,/1 其他/,'protocol calls remain in the Other series instead of disappearing');
 const store=server.deps.records.store,original=store.countIndexed;let countCalls=0;t.after(()=>{store.countIndexed=original;});store.countIndexed=async()=>{countCalls++;return {count:999,capped:false};};
 const none=await get('/console/records?user=synthetic-nobody&days=30',admin);assert.equal(none.status,200);assert.equal(countCalls,0,'an unresolved member must not count all private refusal records');assert.match(none.body,/ch-stat-value">0/);assert.doesNotMatch(none.body,new RegExp(recent.digest+'|'+old.digest));
 assert.equal((await get(base+'&from=2099-01-01',admin)).status,400);assert.equal((await get(base+'&from=2026-11-02&to=2026-11-01',admin)).status,400);
});
