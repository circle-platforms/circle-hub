import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../../records/api.ts';
import type { PageContext } from './context.ts';
import { ACTIONS } from './manage.ts';
import './reset-actions.ts';
import {
  needsRebuildPage,
  rebuildNeededBanner,
  renderRebuildPage,
  RESET_CONFIRM_WORD,
  RESET_SCOPES,
  resetRebuildSection,
} from './reset.ts';

const ADMIN: Principal = { id: 'usr_01aryz0123456789abcdefghjk', name: '合成管理员', role: 'admin' };
const MEMBER: Principal = { id: 'usr_01bryyz0123456789abcdefghjm', name: '合成成员', role: 'user' };

function ctx(principal: Principal, path = '/console/settings?tab=hub'): PageContext {
  const url = new URL(path, 'http://127.0.0.1');
  return {
    deps: {} as PageContext['deps'],
    principal,
    admin: principal.role === 'admin',
    url,
    csrf: 'synthetic-csrf',
    chrome: (title, extra = {}) => ({ title, user: { name: principal.name, role: principal.role, admin: principal.role === 'admin' }, csrf: 'synthetic-csrf', ...extra }),
    userName: async () => principal.name,
  };
}

test('reset ACTION builds argv from scope and keep-config after confirm word', () => {
  const form = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? '' });
  assert.deepEqual(ACTIONS.reset.build(form({ scope: 'history', confirm: RESET_CONFIRM_WORD })), {
    argv: ['reset', '--scope=history'],
  });
  assert.deepEqual(ACTIONS.reset.build(form({ scope: 'all', keep_config: '1', confirm: RESET_CONFIRM_WORD })), {
    argv: ['reset', '--scope=all', '--keep-config'],
  });
  assert.throws(() => ACTIONS.reset.build(form({ scope: 'history', confirm: 'wrong' })), /重建/);
  assert.throws(() => ACTIONS.reset.build(form({ scope: 'runs', confirm: RESET_CONFIRM_WORD })), /范围/);
  assert.throws(() => ACTIONS.reset.build(form({ scope: 'nope', confirm: RESET_CONFIRM_WORD })), /范围/);
});

test('settings reset card lists every scope in plain language and posts to admin/do/reset', () => {
  const body = String(resetRebuildSection(ctx(ADMIN)));
  assert.match(body, /重置和重建/);
  assert.match(body, /action="\/console\/admin\/do\/reset"/);
  assert.match(body, /name="confirm"/);
  assert.match(body, /保留配置重建/);
  for (const row of RESET_SCOPES) {
    assert.match(body, new RegExp(row.label));
    assert.match(body, new RegExp(row.clears.slice(0, 8)));
  }
  assert.equal(String(resetRebuildSection(ctx(MEMBER))), '');
});

test('needs-rebuild page offers archive-and-init and definition restore for an admin', () => {
  const page = needsRebuildPage(ctx(ADMIN, '/console/rebuild'), {
    reason: '当前数据与本版本对不上。',
    detail: '合成检查未通过。',
  });
  assert.equal(page.status, 200);
  const body = String(page.body);
  assert.match(body, /需要重建/);
  assert.match(body, /当前数据与本版本对不上/);
  assert.match(body, /归档并初始化/);
  assert.match(body, /用定义文件恢复/);
  assert.match(body, /circle-hub apply/);
  assert.match(body, /action="\/console\/rebuild\/preview"/);
  assert.match(body, /name="scope" value="all"/);
});

test('renderRebuildPage is a pure document for the lightweight server', () => {
  const anonymous = renderRebuildPage({
    authorized: false,
    csrf: 'anon-csrf',
    loginNonce: 'nonce-1',
    rebuildNeeded: { reason: '库结构与本版本不一致。' },
  });
  assert.match(anonymous, /需要重建/);
  assert.match(anonymous, /action="\/console\/rebuild\/authorize"/);
  assert.match(anonymous, /name="setup_code"/);
  assert.match(anonymous, /name="nonce" value="nonce-1"/);
  assert.doesNotMatch(anonymous, /归档并初始化/);

  const authorized = renderRebuildPage({
    authorized: true,
    csrf: 'auth-csrf',
    actionId: 'action-1',
    rebuildNeeded: { reason: '库结构与本版本不一致。', detail: '合成诊断。' },
  });
  assert.match(authorized, /合成诊断/);
  assert.match(authorized, /action="\/console\/rebuild\/preview"/);
  assert.match(authorized, /action="\/console\/rebuild\/execute"/);
  assert.match(authorized, /name="actionId" value="action-1"/);

  const running = renderRebuildPage({
    authorized: true,
    csrf: 'auth-csrf',
    rebuildNeeded: { reason: '库结构与本版本不一致。' },
    operation: { operationId: '11111111-1111-1111-1111-111111111111', acknowledged: true, running: true, completed: false },
  });
  assert.match(running, /重建进行中/);
  assert.match(running, /href="\/console\/reset-status\/11111111-1111-1111-1111-111111111111"/);
  assert.match(running, /operation=11111111-1111-1111-1111-111111111111/);
});

test('overview banner names the rebuild page', () => {
  const body = String(rebuildNeededBanner({ reason: '库结构与本版本不一致。' }));
  assert.match(body, /需要重建/);
  assert.match(body, /href="\/console\/rebuild"/);
  assert.match(body, /库结构与本版本不一致/);
});
