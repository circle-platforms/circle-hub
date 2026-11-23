import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemberNotificationIntent, MemberNotificationReceipt } from './resources.ts';

const digest = 'a'.repeat(64);
const member = 'usr_0' + 'b'.repeat(25);
const uuid = '682dc0ed-f599-48ec-a3de-e72ff18e6f1d';

test('private notification declarations bind exactly one checked member and target', () => {
  const write = {
    interaction: 'submit_then_read',
    effect_class: 'notification',
    retry_safety: 'unsafe',
    signing: 'service_on_behalf',
    reversible: false,
    target_key: digest,
    audience: member,
    evidence: { call: 'private_send', pointer: '/errcode' },
    refusal: { stage: '/stage', reached_device: '/reached_target' },
    writes_hub_records: true,
  };
  const base = {
    schema: 'member-notification-intent@1',
    kind: 'dispatch',
    receipt: uuid,
    event: uuid,
    member,
    issuer: digest,
    subject: digest,
    channel: digest,
    sha256: digest,
    size: 5,
    name_sha256: null,
    write,
  };
  assert.ok(MemberNotificationIntent.safeParse(base).success);
  for (const change of [
    { effect_class: 'sync_write' },
    { audience: 'usr_0' + 'c'.repeat(25) },
    { target_key: 'e'.repeat(64) },
    { retry_safety: 'same_key_safe' },
  ]) {
    assert.equal(MemberNotificationIntent.safeParse({ ...base, write: { ...write, ...change } }).success, false);
  }
});

test('a platform acknowledgment, a target refusal, and an unresolved delivery require their own evidence', () => {
  const base = {
    schema: 'member-notification-receipt@1',
    member,
    intent: digest,
    receipt: uuid,
    outcome: 'issued',
    reached_target: true,
    acknowledgment: { request: digest, code: 0 },
    missing: null,
    next: null,
  };
  assert.ok(MemberNotificationReceipt.safeParse(base).success);
  assert.equal(MemberNotificationReceipt.safeParse({ ...base, acknowledgment: null }).success, false);
  assert.equal(MemberNotificationReceipt.safeParse({ ...base, outcome: 'target_rejected' }).success, false);
  assert.equal(
    MemberNotificationReceipt.safeParse({ ...base, outcome: 'unknown', reached_target: null, acknowledgment: null }).success,
    false,
  );
  assert.ok(
    MemberNotificationReceipt.safeParse({
      ...base,
      outcome: 'unknown',
      reached_target: null,
      acknowledgment: null,
      missing: '缺回执',
      next: '核对目标',
    }).success,
  );
});
