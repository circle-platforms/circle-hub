// A runtime profile describes one automation test bed. Round 38 of the acceptance runs bound the default profile, which
// described another bed than the one the lineage had booked; the start was refused only for the contract identity it
// expected, with no word of the bed, so the client could not tell a wrong binding from a broken environment.
// Synthetic documents and lease keys only.
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
], parameters: { pipeline: 'legacy', autoid: AUTOID }, context: { leases: { now: '2026-10-23T02:00:00.000Z', entries } } });
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
  assert.match(problem?.fix ?? '', /请管理员把 bed-b 的配置发布到这个名字，或改为预订 bed-a/);
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

// A profile used to hold a copy of the contract's identity. It holds none now (decision 184): one that still carries the field
// is told to drop it, whatever the value, so that no profile looks checked against a contract when nothing compares it.
test('a profile that still carries the retired contract digest says so and says to delete it, besides the bed', () => {
  const profile = { ...(profileDocument() as Record<string, unknown>), runtime: { ...((profileDocument() as { runtime: Record<string, unknown> }).runtime), contract_sha256: runtimeDocument().contract_sha256 } };
  const refused = projectItems(startInput([lease('bed/bed-other/lb1')], profile)) as { error: { message: string; fix: string } };
  assert.match(refused.error.message, /运行环境配置有 2 个问题，整份拒绝：\/bed：运行环境配置属于自动化测试环境 .+，本谱系预订的是 bed-other；\/runtime\/contract_sha256：配置里的合约摘要已退役：工作簿的身份行由生成器按运行锁定的运行器合约写，配置不再存它的副本/);
  assert.match(refused.error.fix, /\/runtime\/contract_sha256：请管理员删除该字段后重新发布这份配置/);
});

// Round 44 of the acceptance runs (2026-11-19): a profile republished for a new runner contract had its field renewed and its
// workbook template not. The start accepted it, all seventeen plans were written, and the merge refused the workbook
// ("运行器模板的运行时或合约身份与本运行的合约不符"). Since decision 184 the template's identity row is not a copy anyone
// compares: the generator writes it from the contract the run locked, so a template saved for another contract starts and
// compiles. The start still refuses a template that cannot be read, which was the other way to lose every plan at the merge.
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
