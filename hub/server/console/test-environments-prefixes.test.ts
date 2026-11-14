// Pure console helpers over fake BookingPrefixRow data; no PostgreSQL, vault or network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { html } from './html.ts';
import {
  BOOKING_PREFIXES_SECTION,
  PREFIX_USAGE_HEADING,
  REGISTER_AS_TEST_ENVIRONMENT,
  REGISTER_FROM_PREFIX_DIALOG,
  bookingPrefixesSection,
  prefixUsageBlock,
  registerAsTestEnvironmentHref,
  registrationDefaultsFromPrefix,
  registerFromPrefixDialog,
  type BookingPrefixRow,
} from './test-environments-prefixes.ts';

const row: BookingPrefixRow = {
  prefix: 'ordinary/bookings/',
  ownerName: '合成责任人',
  holders: [
    { name: '合成持有人甲', since: '2026-11-14T08:00:00.000Z' },
    { name: '合成持有人乙' },
  ],
  workflowAssignees: [
    { kind: 'account', name: '合成成员甲' },
    { kind: 'team', name: '合成一组' },
  ],
};

test('registrationDefaultsFromPrefix keeps prefix and owner name without inventing a target', () => {
  assert.deepEqual(registrationDefaultsFromPrefix(row), {
    prefix: 'ordinary/bookings/',
    owner: '合成责任人',
  });
});

test('registerAsTestEnvironmentHref opens the shared dialog with register_prefix', () => {
  const link = registerAsTestEnvironmentHref('/console/connections', row.prefix, { tab: 'environments' });
  assert.match(link, /\/console\/connections\?/);
  assert.match(link, /tab=environments/);
  assert.match(link, /register_prefix=ordinary%2Fbookings%2F/);
  assert.ok(link.endsWith(`#${REGISTER_FROM_PREFIX_DIALOG}`));
});

test('prefixUsageBlock lists holders and workflow assignees by name', () => {
  const text = prefixUsageBlock(row).text;
  assert.match(text, new RegExp(PREFIX_USAGE_HEADING));
  assert.match(text, /合成持有人甲/);
  assert.match(text, /自 2026-11-14T08:00:00\.000Z/);
  assert.match(text, /合成持有人乙/);
  assert.match(text, /账户 合成成员甲/);
  assert.match(text, /团队 合成一组/);
  assert.doesNotMatch(text, /usr_/);
  assert.doesNotMatch(text, /tm_/);
});

test('prefixUsageBlock reports empty holders and assignees honestly', () => {
  const text = prefixUsageBlock({ prefix: 'lonely/', ownerName: '合成责任人' }).text;
  assert.match(text, /最近没有读到持有者/);
  assert.match(text, /没有读到相关工作流分配的账户或团队/);
});

test('bookingPrefixesSection renders the Chinese column and register entry', () => {
  const page = bookingPrefixesSection([row], {
    pagePath: '/console/connections',
    pageParams: { tab: 'environments' },
    selectedPrefix: row.prefix,
    formFieldsFor: (selected) => {
      const defaults = registrationDefaultsFromPrefix(selected);
      return html`<label>名字<input name="name"></label>
<label>目标<input name="target"></label>
<label>前缀或键<input name="prefix" value="${defaults.prefix}"></label>
<label>owner<input name="owner" value="${defaults.owner}"></label>`;
    },
  });
  const text = page.text;
  assert.match(text, new RegExp(BOOKING_PREFIXES_SECTION));
  assert.match(text, /ordinary\/bookings\//);
  assert.match(text, /合成责任人/);
  assert.match(text, new RegExp(REGISTER_AS_TEST_ENVIRONMENT));
  assert.match(text, new RegExp(`id="${REGISTER_FROM_PREFIX_DIALOG}"`));
  assert.match(text, new RegExp(PREFIX_USAGE_HEADING));
  assert.match(text, /value="ordinary\/bookings\/"/);
  assert.match(text, /value="合成责任人"/);
  assert.doesNotMatch(text, /env_/);
  assert.doesNotMatch(text, /usr_/);
});

test('registerFromPrefixDialog reuses the formal form fields and usage block', () => {
  const markup = registerFromPrefixDialog(
    row,
    html`<input name="prefix" value="${row.prefix}"><input name="owner" value="${row.ownerName}">`,
  ).text;
  assert.match(markup, new RegExp(REGISTER_AS_TEST_ENVIRONMENT));
  assert.match(markup, new RegExp(PREFIX_USAGE_HEADING));
  assert.match(markup, /与正式登记同一张表单/);
  assert.match(markup, /ordinary\/bookings\//);
});
