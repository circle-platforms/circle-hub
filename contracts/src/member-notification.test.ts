import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExternalIdentityActionSchema,
  ExternalIdentityUnbindReasonSchema,
} from '../generated/vocabulary.ts';
import {
  BotSecretChangeAudit,
  MemberBotInbound,
  MemberExternalIdentityAudit,
  MemberNotificationIntent,
  MemberNotificationReceipt,
} from './resources.ts';

const digest = 'a'.repeat(64);
const digest2 = 'b'.repeat(64);
const digest3 = 'c'.repeat(64);
const digest4 = 'd'.repeat(64);
const member = 'usr_0' + 'b'.repeat(25);
const admin = 'usr_0' + 'a'.repeat(25);
const uuid = '682dc0ed-f599-48ec-a3de-e72ff18e6f1d';
const timestamp = '2026-11-24T00:00:00.000Z';

test('private notification declarations bind exactly one checked member and target across text and file', () => {
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
    role: 'assistant',
    sha256: digest,
    size: 5,
    text_sha256: digest2,
    text_size: 5,
    file_sha256: null,
    file_size: null,
    name_sha256: null,
    write,
  };
  assert.ok(MemberNotificationIntent.safeParse(base).success);
  assert.ok(MemberNotificationIntent.safeParse({ ...base, role: 'notice', code: 'new_conversation' }).success);
  const withoutRole: Record<string, unknown> = { ...base };
  delete withoutRole.role;
  assert.equal(MemberNotificationIntent.safeParse(withoutRole).success, false);
  assert.equal(MemberNotificationIntent.safeParse({ ...base, role: 'notice', code: 'x\ny\u0000<script>' }).success, false);
  assert.ok(
    MemberNotificationIntent.safeParse({
      ...base,
      text_sha256: digest2,
      text_size: 5,
      file_sha256: digest3,
      file_size: 12,
      name_sha256: digest4,
      size: 17,
    }).success,
  );
  assert.equal(MemberNotificationIntent.safeParse({ ...base, size: 6 }).success, false);
  assert.equal(MemberNotificationIntent.safeParse({ ...base, text_sha256: null }).success, false);
  assert.equal(MemberNotificationIntent.safeParse({ ...base, file_sha256: digest3 }).success, false);
  assert.equal(MemberNotificationIntent.safeParse({ ...base, file_sha256: null, file_size: null, name_sha256: digest4 }).success, false);
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
  assert.ok(MemberNotificationReceipt.safeParse({ ...base, supersedes: digest2 }).success);
  assert.equal(MemberNotificationReceipt.safeParse({ ...base, acknowledgment: null }).success, false);
  assert.equal(MemberNotificationReceipt.safeParse({ ...base, outcome: 'target_rejected' }).success, false);
  assert.equal(MemberNotificationReceipt.safeParse({ ...base, outcome: 'issued', reached_target: false }).success, false);
  assert.equal(MemberNotificationReceipt.safeParse({ ...base, outcome: 'issued', reached_target: null }).success, false);
  assert.equal(
    MemberNotificationReceipt.safeParse({ ...base, outcome: 'not_dispatched', reached_target: true, acknowledgment: null }).success,
    false,
  );
  assert.equal(
    MemberNotificationReceipt.safeParse({ ...base, outcome: 'not_dispatched', reached_target: null, acknowledgment: null }).success,
    false,
  );
  assert.equal(
    MemberNotificationReceipt.safeParse({ ...base, outcome: 'unknown', reached_target: null, acknowledgment: null }).success,
    false,
  );
  assert.equal(
    MemberNotificationReceipt.safeParse({
      ...base,
      outcome: 'unknown',
      reached_target: null,
      acknowledgment: null,
      missing: ['缺平台确认回执'],
      next: null,
    }).success,
    false,
  );
  assert.equal(
    MemberNotificationReceipt.safeParse({
      ...base,
      outcome: 'unknown',
      reached_target: true,
      acknowledgment: null,
      missing: ['缺平台确认回执'],
      next: '核对目标',
    }).success,
    false,
  );
  assert.equal(
    MemberNotificationReceipt.safeParse({
      ...base,
      outcome: 'unknown',
      reached_target: false,
      acknowledgment: null,
      missing: ['缺平台确认回执'],
      next: '核对目标',
    }).success,
    false,
  );
  assert.equal(
    MemberNotificationReceipt.safeParse({
      ...base,
      outcome: 'unknown',
      reached_target: null,
      acknowledgment: null,
      missing: [],
      next: '核对目标',
    }).success,
    false,
  );
  assert.ok(
    MemberNotificationReceipt.safeParse({
      ...base,
      outcome: 'unknown',
      reached_target: null,
      acknowledgment: null,
      missing: ['缺平台确认回执'],
      next: '核对目标',
    }).success,
  );
});

test('bot inbound and audit record contracts enforce required invariants', () => {
  const inbound = {
    schema: 'member-bot-inbound@1',
    kind: 'dispatch',
    request: uuid,
    member,
    issuer: digest,
    subject: digest2,
    channel: digest3,
    platform_id_sha256: digest4,
    text_sha256: digest,
    text_size: 4,
    files: [],
    at: timestamp,
  };
  assert.ok(MemberBotInbound.safeParse(inbound).success);
  assert.equal(
    MemberBotInbound.safeParse({
      ...inbound,
      text_sha256: null,
      text_size: 0,
    }).success,
    false,
  );
  assert.equal(
    MemberBotInbound.safeParse({
      ...inbound,
      text_sha256: digest,
      text_size: 0,
      files: [{ sha256: digest, size: 1, name_sha256: digest2 }],
    }).success,
    false,
  );
  assert.equal(
    MemberBotInbound.safeParse({
      ...inbound,
      text_sha256: null,
      text_size: 5,
    }).success,
    false,
  );
  assert.ok(
    MemberExternalIdentityAudit.safeParse({
      schema: 'member-external-identity@1',
      action: 'bind',
      by: member,
      member,
      issuer: digest,
      subject: digest2,
      at: timestamp,
    }).success,
  );
  assert.ok(
    MemberExternalIdentityAudit.safeParse({
      schema: 'member-external-identity@1',
      action: 'unbind',
      by: admin,
      member,
      issuer: digest,
      subject: digest2,
      at: timestamp,
      reason: 'manual',
    }).success,
  );
  assert.equal(
    MemberExternalIdentityAudit.safeParse({
      schema: 'member-external-identity@1',
      action: 'unbind',
      by: admin,
      member,
      issuer: digest,
      subject: digest2,
      at: timestamp,
    }).success,
    false,
  );
  assert.equal(ExternalIdentityActionSchema.safeParse('rotate').success, false);
  assert.equal(ExternalIdentityUnbindReasonSchema.safeParse('expired').success, false);
  assert.equal(
    MemberExternalIdentityAudit.safeParse({
      schema: 'member-external-identity@1',
      action: 'rotate',
      by: admin,
      member,
      issuer: digest,
      subject: digest2,
      at: timestamp,
    }).success,
    false,
  );
  assert.equal(
    MemberExternalIdentityAudit.safeParse({
      schema: 'member-external-identity@1',
      action: 'unbind',
      by: admin,
      member,
      issuer: digest,
      subject: digest2,
      at: timestamp,
      reason: 'expired',
    }).success,
    false,
  );
  for (const action of ['set', 'start_channel'] as const) {
    assert.ok(
      BotSecretChangeAudit.safeParse({
        schema: 'bot-secret-change@1',
        action,
        slot: 'model',
        by: admin,
        at: timestamp,
      }).success,
    );
  }
  assert.equal(
    BotSecretChangeAudit.safeParse({
      schema: 'bot-secret-change@1',
      action: 'set',
      slot: 'personal-bot.model',
      by: admin,
      at: timestamp,
    }).success,
    false,
  );
  assert.equal(
    BotSecretChangeAudit.safeParse({
      schema: 'bot-secret-change@1',
      action: 'rotate',
      slot: 'model',
      by: admin,
      at: timestamp,
    }).success,
    false,
  );
});
