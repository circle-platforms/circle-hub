import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { SystemProfile, parsePathTemplate, templateReaches } from '../../../contracts/src/resources.ts';
import { compileRoutes, matchRoute } from '../../../hub/connectors/api.ts';
import { WRITE_PATH, TOKEN_PATH, wecomReply } from '../../../tests/fixtures/wecom/index.ts';
import { manifestProblems } from '../../workflow/case-review/packaging.ts';
import { chatProject, isChatKey, isMemberKey, memberProject } from './functions/wecom.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));

describe('the profile', () => {
  test('lists the two read routes one by one and no write route; the send path under the same prefix is refused', () => {
    assert.deepEqual(
      profile.routes.map((r) => `${r.method} ${r.path}`),
      ['GET /cgi-bin/user/get', 'POST /cgi-bin/appchat/get'],
    );
    for (const route of profile.routes) {
      assert.equal(route.read, true);
      assert.doesNotMatch(route.path, /\{/, 'literal paths: no template can reach another path under the prefix');
      assert.equal(templateReaches(parsePathTemplate(route.path), parsePathTemplate(WRITE_PATH)), false, route.id);
    }
    const routes = compileRoutes(profile.routes);
    assert.throws(() => matchRoute(routes, { method: 'POST', path: WRITE_PATH, query: {}, body: { chatid: 'syn_chat_001', text: 'x' } }), 'the send route is refused by the route list');
    assert.throws(() => matchRoute(routes, { method: 'GET', path: TOKEN_PATH, query: { corpid: 'x', corpsecret: 'y' }, body: undefined }), 'a token exchange is not a declared read either');
    assert.ok(matchRoute(routes, { method: 'GET', path: '/cgi-bin/user/get', query: { userid: 'syn_u_001' }, body: undefined }), 'the member read matches');
  });

  test('auth is a vault bearer token; the envelope is the errcode one; each read is one declared request', () => {
    assert.equal(profile.auth.kind, 'static_header');
    assert.notEqual((profile.auth as { credential: string }).credential, 'session');
    assert.equal(profile.envelope?.code, '/errcode');
    assert.deepEqual(profile.envelope?.ok, [0]);
    assert.deepEqual(
      profile.reads.map((r) => `${r.external} via ${r.request?.route}`),
      ['wecom:user via member-get', 'wecom:chat via chat-get'],
    );
    assert.deepEqual(profile.reads[0]?.request?.query, { userid: '{id}' });
    assert.deepEqual(profile.reads[1]?.request?.body, { chatid: '{id}' });
    for (const read of profile.reads) assert.deepEqual(read.absent_codes, ['wecom.absent']);
  });

  test('pack.json is current against the files on disk', async () => {
    assert.deepEqual(await manifestProblems(fileURLToPath(new URL('./', import.meta.url))), []);
  });
});

describe('the read functions', () => {
  const memberAnswers = { get: { ok: true, json: wecomBody({ method: 'GET', path: '/cgi-bin/user/get', query: { userid: 'syn_u_001' } }) } };
  function wecomBody(request: Parameters<typeof wecomReply>[0]): unknown {
    return JSON.parse(wecomReply(request).body);
  }

  test('member keys are validated by shape, not by guessing membership', () => {
    assert.equal(isMemberKey('syn_u_001'), true);
    assert.equal(isMemberKey('zhangsan@corp'), true);
    assert.equal(isMemberKey(''), false);
    assert.equal(isMemberKey('a'.repeat(65)), false);
    assert.equal(isMemberKey('bad 中文'), false);
  });

  test('the member projection keeps every answered field and leaves missing ones null', () => {
    const full = memberProject({ external: { type: 'user', key: 'syn_u_001' }, responses: memberAnswers, original: 'get' }) as {
      artifacts: { name: string; json: Record<string, unknown> }[];
    };
    const content = full.artifacts[0]?.json;
    assert.deepEqual(content, { userid: 'syn_u_001', name: '合成-甲', department: [7], status: 1, mobile: '13800000000', email: 'syn001@example.invalid' });
    assert.deepEqual(full.artifacts[1]?.json, { userid: 'syn_u_001', name: '合成-甲' });
    const partial = memberProject({ external: { type: 'user', key: 'syn_u_002' }, responses: { get: { ok: true, json: wecomBody({ method: 'GET', path: '/cgi-bin/user/get', query: { userid: 'syn_u_002' } }) } }, original: 'get' }) as {
      artifacts: { json: Record<string, unknown> }[];
    };
    assert.equal(partial.artifacts[0].json.mobile, null);
    assert.equal(partial.artifacts[0].json.email, null);
    assert.deepEqual(partial.artifacts[0].json.department, [7, 9]);
  });

  test('a member the tenant does not name is a recorded absence, not a failure', () => {
    const absent = memberProject({ external: { type: 'user', key: 'syn_u_404' }, responses: { get: { ok: true, json: { errcode: 0, errmsg: 'ok' } } }, original: 'get' });
    assert.deepEqual((absent as { error: { code: string } }).error.code, 'wecom.absent');
    assert.ok(isMemberKey('syn_u_404'), 'the key is well-formed: absence is the answer, not the key');
    assert.deepEqual((memberProject({ external: { type: 'user', key: 'bad key' }, responses: memberAnswers, original: 'get' }) as { error: { code: string } }).error.code, 'wecom.invalid_key');
    assert.deepEqual((memberProject({ external: { type: 'task', key: 'syn_u_001' }, responses: memberAnswers, original: 'get' }) as { error: { code: string } }).error.code, 'wecom.invalid_type');
  });

  test('the chat projection names owner and members from chat_info', () => {
    const chat = wecomBody({ method: 'POST', path: '/cgi-bin/appchat/get', json: { chatid: 'syn_chat_001' } });
    const projected = chatProject({ external: { type: 'chat', key: 'syn_chat_001' }, responses: { get: { ok: true, json: chat } }, original: 'get' }) as {
      artifacts: { name: string; json: Record<string, unknown> }[];
    };
    assert.deepEqual(projected.artifacts[0]?.json, { chatid: 'syn_chat_001', name: '合成-评审群', owner: 'syn_u_001', users: ['syn_u_001', 'syn_u_002'], department: [7] });
    assert.deepEqual(projected.artifacts[1]?.json, { chatid: 'syn_chat_001', name: '合成-评审群', owner: 'syn_u_001' });
    assert.equal(isChatKey('syn-chat-001'), true);
    assert.equal(isChatKey('bad chat'), false);
  });

  test('a chat answered without its own chat_info is an absence; the answer echoing a different chatid is an absence', () => {
    const none = chatProject({ external: { type: 'chat', key: 'syn_chat_404' }, responses: { get: { ok: true, json: { errcode: 0, errmsg: 'ok' } } }, original: 'get' });
    assert.deepEqual((none as { error: { code: string } }).error.code, 'wecom.absent');
    const other = chatProject({ external: { type: 'chat', key: 'syn_chat_001' }, responses: { get: { ok: true, json: { errcode: 0, chat_info: { chatid: 'syn_chat_999', name: '别的群' } } } }, original: 'get' });
    assert.deepEqual((other as { error: { code: string } }).error.code, 'wecom.absent');
  });
});
