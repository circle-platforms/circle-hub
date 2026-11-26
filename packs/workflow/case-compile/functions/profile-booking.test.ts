import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookedBeds, bookingProblem } from './profile.ts';
import { projectItems } from './project.ts';
import { MANIFEST_DOC } from './test-support.ts';
import { runtimeDocument, profileDocument } from '../testing/runtime.ts';
import { templateDocument } from '../testing/template.ts';

const AUTOID = '990000000000000801';
const model = { nodes: [
  { text: '合成文档', data: { id: 'doc' }, children: [1] },
  { text: '合成标题', data: { id: 'case-1', resource: ['功能'], autoid: AUTOID, auto: '01', priority: '02' }, children: [2] },
  { text: '执行 widget health interval 60', data: {}, children: [3] },
  { text: '期望成功', data: {}, children: [] },
] };
const lease = (key: string, mine = true) => ({ key, until: null, mine });
const startInput = (entries: unknown[], profile: unknown = profileDocument()) => ({ inputs: [
  { slot: 'subject', sha256: 'a'.repeat(64), parser: 'kityminder@1', model },
  { slot: 'contract', model: runtimeDocument() }, { slot: 'profile', model: profile }, { slot: 'inventory', model: MANIFEST_DOC },
], parameters: { autoid: AUTOID }, context: { leases: { now: '2026-10-23T02:00:00.000Z', entries } } });
const profileBed = (profileDocument() as { bed: string }).bed;

test('the booked beds are the beds of the device leases the lineage holds, not address keys or leases of others', () => {
  assert.deepEqual(bookedBeds({ entries: [lease('bed/bed-b/lb1'), lease('bed/bed-b/ip/192.0.2.9'), lease('bed/bed-c/lb1', false), lease('other/x/y'), lease('bed/bed-a/r1'), lease('bed/bed-b/r1')] }), ['bed-a', 'bed-b']);
  assert.deepEqual(bookedBeds(undefined), []);
  assert.deepEqual(bookedBeds({ entries: 'not a list' }), []);
});

test('a profile of another bed than the booked one is a problem at /bed that names both beds and who changes what', () => {
  assert.equal(bookingProblem({ bed: 'bed-a' }, { entries: [] }), null, 'a lineage without a booking is not checked');
  assert.equal(bookingProblem({ bed: 'bed-a' }, { entries: [lease('bed/bed-a/lb1')] }), null);
  const problem = bookingProblem({ bed: 'bed-a' }, { entries: [lease('bed/bed-b/lb1')] });
  assert.equal(problem?.pointer, '/bed');
  assert.equal(problem?.message, '运行环境配置属于自动化测试环境 bed-a，本谱系预订的是 bed-b');
  assert.match(problem?.fix ?? '', /绑定属于 bed-b 的运行环境配置命名文档/);
  assert.match(problem?.fix ?? '', /请按本次预订的执行器登记重新开编译/);
});

test('the start refuses a profile of another bed than the booked one, at /inputs/profile, before any item is built', () => {
  const refused = projectItems(startInput([lease('bed/bed-other/lb1')])) as { error?: { code: string; message: string; fix: string; pointer?: string } };
  assert.equal(refused.error?.code, 'case-compile.profile_invalid', JSON.stringify(refused).slice(0, 400));
  assert.equal(refused.error?.pointer, '/inputs/profile');
  assert.match(refused.error!.message, new RegExp(`/bed：运行环境配置属于自动化测试环境 ${profileBed}，本谱系预订的是 bed-other`));
  const booked = projectItems(startInput([lease(`bed/${profileBed}/lb1`)])) as { error?: unknown; items?: unknown[] };
  assert.equal(booked.error, undefined, JSON.stringify(booked).slice(0, 400));
  assert.equal(booked.items?.length, 1);
});

test('the start takes a profile whose workbook template was saved with another identity, and refuses one whose template cannot be read', () => {
  const profile = profileDocument() as unknown as { runtime: { minimum_version: string }; workbook: { sheet: string; header: string[]; identity_marker: string; range_name: string } };
  const stale = { ...profile, workbook: { ...profile.workbook, template: templateDocument(profile.workbook, 'another-runtime', 'e'.repeat(64)) } };
  assert.equal((projectItems(startInput([lease(`bed/${profileBed}/lb1`)], stale)) as { error?: unknown }).error, undefined);
  const unreadable = { ...profile, workbook: { ...profile.workbook, template: { sha256: 'a'.repeat(64), xlsx_base64: 'AAAA' } } };
  const refused = projectItems(startInput([lease(`bed/${profileBed}/lb1`)], unreadable)) as { error?: { code: string; message: string; fix: string; pointer?: string } };
  assert.equal(refused.error?.code, 'case-compile.profile_invalid', JSON.stringify(refused).slice(0, 400));
  assert.equal(refused.error?.pointer, '/inputs/profile');
  assert.match(refused.error!.message, /整份拒绝：\/workbook\/template：/);
  assert.match(refused.error!.fix, /\/workbook\/template：请管理员换成能读出的运行器模板后重新发布这份配置/);
  assert.equal((projectItems(startInput([lease(`bed/${profileBed}/lb1`)])) as { error?: unknown }).error, undefined);
});
