// One assertion per connector code: the caller text names the missing fact and a next step, and carries no host or credential.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTOR_ERRORS, type ConnectorErrorCode } from './errors.ts';
import { adminCommand, READ_EXITS } from './read-exit.ts';

const HOST = /\b(?:\d{1,3}\.){3}\d{1,3}\b|:[0-9a-f]{0,4}:/i;
const SECRET = /password|token|bearer|secret|authorization/i;
const STEP = /重读|重新开始|修复|核对|调整|恢复|补上|修正|启用/;
const PRIVATE = new Set<ConnectorErrorCode>(['ACCESS_DENIED', 'READER_INVALID', 'CREDENTIAL_MISSING', 'CREDENTIAL_REFUSED', 'LOGIN_FAILED', 'SOURCE_LOGIN_EXPIRED', 'SOURCE_FORBIDDEN', 'SOURCE_CREDENTIAL']);

for (const code of Object.keys(CONNECTOR_ERRORS) as ConnectorErrorCode[]) {
  test(`${code} names the missing fact and the next step without a host or a credential`, () => {
    const exit = READ_EXITS[code];
    const command = adminCommand(exit.admin, 'res_synthetic', ['DEMO_PORTAL_PASSWORD']);
    assert.equal(HOST.test(command), false, command);
    if (exit.caller === null) {
      assert.equal(PRIVATE.has(code), true);
      if (code === 'ACCESS_DENIED' || code === 'READER_INVALID') assert.match(command, /核对账号是否启用/);
      else assert.match(command, /circle-hub /);
      return;
    }
    const text = `${exit.caller.message} ${exit.caller.fix}`;
    assert.equal(exit.caller.message.length > 0, true);
    assert.match(text, STEP, text);
    assert.equal(HOST.test(text), false, text);
    assert.equal(SECRET.test(text), false, text);
    assert.equal(text.includes(CONNECTOR_ERRORS[code]) || code === 'SOURCE_ABSENT', true, text);
  });
}

test('unreachable and timeout tell Circle to retry and the administrator to show the resource', () => {
  for (const code of ['SOURCE_UNREACHABLE', 'SOURCE_TIMEOUT'] as const) {
    assert.equal(READ_EXITS[code].caller?.fix, '稍后用同样参数重新开始；仍失败请管理员核对资源地址与网络');
    assert.equal(adminCommand(READ_EXITS[code].admin, 'res_synthetic'), 'circle-hub resource show res_synthetic');
  }
});

test('credential and identity failures stay hidden from the caller and name the administrator command', () => {
  const hidden = /凭据|密钥库|登录/;
  for (const code of ['SOURCE_LOGIN_EXPIRED', 'LOGIN_FAILED', 'CREDENTIAL_MISSING', 'CREDENTIAL_REFUSED', 'SOURCE_FORBIDDEN', 'SOURCE_CREDENTIAL'] as const) {
    assert.equal(READ_EXITS[code].caller, null);
  }
  for (const code of ['SOURCE_LOGIN_EXPIRED', 'LOGIN_FAILED', 'CREDENTIAL_MISSING', 'CREDENTIAL_REFUSED'] as const) {
    const command = adminCommand(READ_EXITS[code].admin, 'res_synthetic', ['DEMO_PORTAL_PASSWORD']);
    assert.match(command, /circle-hub secret set --name DEMO_PORTAL_PASSWORD 或 circle-hub resource reset-login res_synthetic/);
    assert.equal(command.includes('hunter2'), false);
  }
  assert.equal(adminCommand(READ_EXITS.SOURCE_FORBIDDEN.admin, 'res_synthetic'), 'circle-hub resource show res_synthetic');
});
