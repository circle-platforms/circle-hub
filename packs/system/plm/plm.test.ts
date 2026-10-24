import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../hub/connectors/testing/credentials.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { SystemProfile, parsePathTemplate, templateReaches } from '../../../contracts/src/resources.ts';
import { matchRoute, compileRoutes } from '../../../hub/connectors/api.ts';
import { startAgileStub, startStub, type AgileStub, type StubServer } from '../../../hub/connectors/testing/api.ts';
import type { ExternalRead } from '../../../hub/ports.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { AGILE_ACCOUNT, agileOptions } from '../../../tests/fixtures/agile/index.ts';
import { WRITE_PATH, plmReply } from '../../../tests/fixtures/plm/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';
import { bugsPlan, bugsProject, detailPlan, detailProject, htmlText, isHtml } from './functions/plm.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));

describe('the profile', () => {
  test('lists every read route one by one and no write route; the write path under the read prefix matches none', () => {
    assert.deepEqual(
      profile.routes.map((r) => `${r.method} ${r.path}`),
      ['GET /plmquery/product/all/', 'GET /plmquery/build/', 'POST /plmquery/bug/detail/', 'POST /plmquery/story/detail/'],
    );
    for (const route of profile.routes) {
      assert.equal(route.read, true);
      assert.doesNotMatch(route.path, /\{/, 'literal paths: no template can reach another path under the prefix');
      assert.equal(templateReaches(parsePathTemplate(route.path), parsePathTemplate(WRITE_PATH)), false, route.id);
    }
    const routes = compileRoutes(profile.routes);
    assert.throws(() => matchRoute(routes, { method: 'POST', path: WRITE_PATH, query: {}, body: { id: 1 } }), 'the write route is refused by the route list');
    assert.throws(() => matchRoute(routes, { method: 'POST', path: '/plmquery/bug/detail/', query: {}, body: { bug_ids: [1], status: 'closed' } }), 'a body the read does not allow');
  });
});

describe('the read functions', () => {
  test('one detail request for the one id; anything else plans nothing', () => {
    assert.deepEqual(detailPlan({ external: { type: 'bug', key: '31057' } }).requests, [{ key: 'detail', route: 'bug-detail', body: { bug_ids: [31057] } }]);
    assert.deepEqual(detailPlan({ external: { type: 'story', key: '17206' } }).requests, [{ key: 'detail', route: 'story-detail', body: { story_ids: [17206] } }]);
    for (const input of [{ external: { type: 'bug', key: '0' } }, { external: { type: 'bug', key: '12a' } }, { external: { type: 'task', key: '1' } }, null]) assert.deepEqual(detailPlan(input), { requests: [], done: true });
  });

  test('HTML fields become plain text; ids as numbers or strings find the record', () => {
    assert.equal(htmlText('<p>1. 配置 <b>500</b></p><p>预期：down</p>'), '1. 配置 500\n预期：down');
    assert.equal(htmlText('<ol><li>设置权重 0</li><li>发起连接</li></ol>'), '- 设置权重 0\n- 发起连接');
    assert.equal(htmlText('a&nbsp;&amp;&nbsp;b &#x4e2d; &bogus;'), 'a & b 中 &bogus;');
    assert.equal(isHtml('a < b > c'), false);
    assert.equal(isHtml('<br/>'), true);
    const responses = { detail: { ok: true, json: { code: 1000, data: [{ id: 7, title: 'x', steps: '<p>a</p>' }, { id: '8', title: 'y' }] } } };
    const projected = detailProject({ external: { type: 'bug', key: '7' }, responses, original: 'detail' }) as { artifacts: { name: string; json: { fields: Record<string, unknown>; html_fields: string[] } }[] };
    assert.deepEqual(projected.artifacts[0].json.fields, { id: '7', title: 'x', steps: 'a' });
    assert.deepEqual(projected.artifacts[0].json.html_fields, ['steps']);
    assert.ok('error' in (detailProject({ external: { type: 'bug', key: '9' }, responses, original: 'detail' }) as object));
  });

  test('batch bugs plan: sorts numerically, dedupes, enforces 50 limit; invalid keys plan nothing', () => {
    assert.deepEqual(bugsPlan({ external: { type: 'bugs', key: '70412+31057' } }).requests, [
      { key: 'detail', route: 'bug-detail', body: { bug_ids: [31057, 70412] } },
    ]);
    assert.deepEqual(bugsPlan({ external: { type: 'bugs', key: '31057+31057' } }).requests, [
      { key: 'detail', route: 'bug-detail', body: { bug_ids: [31057] } },
    ]);
    const fifty = Array.from({ length: 50 }, (_, i) => String(i + 1)).join('+');
    assert.equal(bugsPlan({ external: { type: 'bugs', key: fifty } }).requests.length, 1);
    const fiftyOne = Array.from({ length: 51 }, (_, i) => String(i + 1)).join('+');
    assert.deepEqual(bugsPlan({ external: { type: 'bugs', key: fiftyOne } }), { requests: [], done: true });
    for (const bad of ['', '0', '12+0', 'abc', '1+2+']) {
      assert.deepEqual(bugsPlan({ external: { type: 'bugs', key: bad } }), { requests: [], done: true }, bad);
    }
  });

  test('batch bugs project: keeps raw status untranslated and lists unreturned ids as unread', () => {
    const responses = {
      detail: {
        ok: true,
        json: {
          code: 1000,
          data: [
            { id: 31057, status: 'resolved', title: '示例网关探活' },
            { id: '70412', status: 'closed', title: '信标权重' },
            { id: '70413', stage: 'testing', name: '有stage无status' },
            { id: '70414' },
          ],
        },
      },
    };
    const projected = bugsProject({ external: { type: 'bugs', key: '31057+70412+70413+70414+99999' }, responses, original: 'detail' }) as {
      artifacts: { name: string; json: { bugs: Array<{ id: string; status: string | null; title: string | null }>; unread: string[] } }[];
    };
    assert.deepEqual(projected.artifacts[0].json.bugs, [
      { id: '31057', status: 'resolved', title: '示例网关探活' },
      { id: '70412', status: 'closed', title: '信标权重' },
      { id: '70413', status: null, title: null },
      { id: '70414', status: null, title: null },
    ]);
    assert.deepEqual(projected.artifacts[0].json.unread, ['99999']);
    assert.equal('missing' in projected.artifacts[0].json, false);
  });
});

describe('reads through the connectors', () => {
  let postgres: TemporaryPostgres;
  let kit: SystemKit;
  let agile: AgileStub;
  let plm: StubServer;
  let writes = 0;

  before(async () => {
    postgres = await startPostgres();
    kit = await openSystemKit(postgres, ['plm']);
    agile = await startAgileStub(agileOptions());
    plm = await startStub((request) => plmReply(request, (token) => agile.tokens.has(token), () => void (writes += 1)));
    const { id } = await addSyntheticResource(kit.records, kit.packs, kit.connectors, kit.admin, { system_pack: 'plm', name: '合成 PLM', environment: 'shared', origins: { 'plm-oauth': agile.origin, 'plm-api': plm.origin }, allow_plaintext: [agile.origin, plm.origin] });
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, id, 'username', AGILE_ACCOUNT.username);
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, id, 'password', AGILE_ACCOUNT.password);
  });
  after(async () => {
    await plm?.close();
    await agile?.close();
    await kit?.close();
    await postgres?.stop();
  });

  const read = (id: string): Promise<ExternalRead> => kit.connectors.reader.read(id, { principal: kit.user, run: null, purpose: '期望来源' });
  const artifact = async (r: ExternalRead, name: string): Promise<unknown> => {
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    if (!r.ok) return null;
    const found = r.artifacts.find((a) => a.name === name);
    assert.ok(found, name);
    return JSON.parse(new TextDecoder().decode(await artifactBytes(kit, found.artifact.body.sha256)));
  };

  test('a bug and a story: plain-text content and a meta title', async () => {
    const bug = (await artifact(await read('plm:bug:31057'), 'content')) as { kind: string; fields: Record<string, unknown> };
    assert.equal(bug.kind, 'bug');
    assert.equal(bug.fields.steps, '1. 配置 http 探测，后端返回 500\n2. 执行 show health\n预期：后端状态为 down');
    assert.equal(bug.fields.openedDate, '2026-01-02 09:30:00', 'dates stay as the service wrote them');
    const meta = (await artifact(await read('plm:story:31057'), 'meta')) as { title: string; status: string };
    assert.deepEqual(meta, { id: '31057', kind: 'story', title: '需求 31057 示例网关支持 HTTP 探活与权重联动', status: 'developed' });
    const story = (await artifact(await read('plm:story:31057'), 'content')) as { fields: { spec: string } };
    assert.equal(story.fields.spec, '健康检查支持 tcp 与 http 两种探测；探测间隔 1 到 60 秒，重试 1 到 10 次。\n连续失败达到重试次数后摘除后端 & 恢复后重新加入。');
  });

  test('an id absent from the service is an observation; the build list is a plain array', async () => {
    const missing=await read('plm:bug:99999');assert.ok(missing.ok && missing.absent?.code==='SOURCE_ABSENT');
    assert.equal(((await artifact(missing,'content')) as {code:string}).code,'SOURCE_ABSENT');
    const noStory=await read('plm:story:70412');assert.ok(noStory.ok && noStory.absent?.code==='SOURCE_ABSENT','a bug id is no story');
    const builds = (await artifact(await read('plm:builds:28'), 'original')) as unknown[];
    assert.equal(builds.length, 3);
    const products = (await artifact(await read('plm:products:all'), 'original')) as { data: unknown[] };
    assert.equal(products.data.length, 2);
  });

  test('batch bugs through connectors: returns status without translation and unread ids', async () => {
    const content = (await artifact(await read('plm:bugs:31057+70412+99999'), 'content')) as {
      bugs: Array<{ id: string; status: string; title: string | null }>;
      unread: string[];
    };
    assert.deepEqual(content.bugs, [
      { id: '31057', status: 'resolved', title: '示例网关的 HTTP 探活在后端返回 500 时仍判定为健康' },
      { id: '70412', status: 'closed', title: '信标权重为 0 时仍被调度' },
    ]);
    assert.deepEqual(content.unread, ['99999']);
  });

  test('batch stories through connectors preserves raw fields and missing ids', async () => {
    const content = (await artifact(await read('plm:stories:31057+99999'), 'content')) as {
      stories: Array<{ id: string; status: string | null; stage: string | null }>; unread: string[];
    };
    assert.equal(content.stories.length, 1);
    assert.equal(content.stories[0].id, '31057');
    assert.equal(content.stories[0].status, null);
    assert.equal(content.stories[0].stage, 'developed');
    assert.deepEqual(content.unread, ['99999']);
  });

  test('nothing ever reached the write route', () => {
    assert.equal(writes, 0);
    assert.ok(plm.requests.every((r) => r.path !== WRITE_PATH));
  });
});
