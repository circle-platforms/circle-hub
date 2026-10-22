// Tests of the test-bed scenario (synthetic tool results):
// - a Hub-shaped answer with the exact free wording, the devices and the hours passes
// - a missing qualifier, a missing bed, a wrong earliest-free moment, an unnamed device and wrong hours each fail
// - the respond flow: search run -> its pages -> acquire run -> its pages -> done, following the next-page marker
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoggedTurn, Scenario } from '../lib/accept.ts';
import type { Turn } from '../scripted-model.ts';
import testBed, { IDLE_WORDING, earliestWording, type TestBedGold } from './test-bed.ts';

const gold: TestBedGold = {
  inventory: 'bed-topology',
  need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }], hours: 2 },
  beds: [
    { name: 'bed-a', free: 'idle' },
    { name: 'bed-b', free: '2026-10-22T18:00:00.000Z' },
  ],
  acquire: { bed: 'bed-a', devices: ['apv0', 'client0'], hours: 2 },
};

const rec = 'rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const searchRunText = [
  '运行 run_1 完成：任务包 test-bed@1.0.0',
  `完整结果 ${rec}：用 get_nodes 读第一页`,
].join('\n');

const searchPage = [
  `内容 ${rec}：`,
  `位置：条目 bed-a；陈述：台架 bed-a：${IDLE_WORDING}；没有记录（未知）`,
  `位置：条目 bed-b；陈述：台架 bed-b：${earliestWording('2026-10-22T18:00:00.000Z')}；没有记录（未知）`,
].join('\n');

const acquireRunText = [
  '运行 run_2 完成：任务包 test-bed@1.0.0',
  `完整结果 ${rec}：用 get_nodes 读第一页`,
].join('\n');

const acquirePage = [
  `内容 ${rec}：`,
  '位置：条目 bed-a；陈述：预订 bed-a，设备 apv0、client0，2 小时',
].join('\n');

const turnsOf = (...texts: string[]): LoggedTurn[] => [
  { index: 0, toolResults: [], tools: ['hub_start_run'] },
  ...texts.map((text, at) => ({ index: at + 1, toolResults: [{ id: `r${at}`, text, isError: false }], tools: [] })),
];

const allOk = (scenario: Scenario, turns: LoggedTurn[]): boolean => scenario.check(turns).every((c) => c.ok);
const fullTurns = (): LoggedTurn[] => turnsOf(searchRunText, searchPage, acquireRunText, acquirePage);

describe('test-bed scenario checks', () => {
  const scenario = testBed(gold);

  test('holds on a Hub-shaped answer with the exact wording, the devices and the hours', () => {
    assert.ok(allOk(scenario, fullTurns()), JSON.stringify(scenario.check(fullTurns()), null, 2));
  });

  test('fails when the idle qualifier is not the exact wording', () => {
    const bad = fullTurns();
    bad[2].toolResults[0].text = searchPage.replace(IDLE_WORDING, '空闲');
    const checks = scenario.check(bad);
    assert.ok(!checks.every((c) => c.ok));
    const bedA = checks.find((c) => c.name.includes('台架 bed-a'));
    assert.ok(bedA && !bedA.ok);
  });

  test('fails when a bed has no conclusion', () => {
    const bad = fullTurns();
    bad[2].toolResults[0].text = searchPage.split('\n').filter((line) => !line.includes('bed-b')).join('\n');
    const checks = scenario.check(bad);
    const bedB = checks.find((c) => c.name.includes('台架 bed-b'));
    assert.ok(bedB && !bedB.ok && bedB.actual.includes('没有这个台架的结论'));
  });

  test('fails when the earliest-free moment differs from the gold', () => {
    const bad = fullTurns();
    bad[2].toolResults[0].text = searchPage.replace('2026-10-22T18:00:00.000Z', '2026-10-22T20:00:00.000Z');
    const checks = scenario.check(bad);
    const bedB = checks.find((c) => c.name.includes('台架 bed-b'));
    assert.ok(bedB && !bedB.ok);
  });

  test('fails when the acquire conclusion does not name a device', () => {
    const bad = fullTurns();
    bad[4].toolResults[0].text = acquirePage.replace('apv0、client0', 'apv0');
    const checks = scenario.check(bad);
    const device = checks.find((c) => c.name.includes('client0'));
    assert.ok(device && !device.ok);
  });

  test('fails when the hours differ', () => {
    const bad = fullTurns();
    bad[4].toolResults[0].text = acquirePage.replace('2 小时', '4 小时');
    const checks = scenario.check(bad);
    const hours = checks.find((c) => c.name.includes('时长'));
    assert.ok(hours && !hours.ok);
  });

  test('fails when a run errors instead of producing a result', () => {
    const bad = fullTurns();
    bad[3].toolResults[0].text = '出错：LEASE_UNAVAILABLE：bed/bed-a/apv0 被占';
    const checks = scenario.check(bad);
    const runs = checks.find((c) => c.name.includes('两次运行'));
    assert.ok(runs && !runs.ok);
  });
});

describe('test-bed scenario respond flow', () => {
  const makeTurn = (index: number, text = ''): Turn => ({
    index,
    system: null,
    messages: [],
    tools: [],
    toolResults: text ? [{ id: 'r', text, isError: false }] : [],
  });

  test('search run, its pages, acquire run, its pages, done', async () => {
    const s = testBed(gold);
    const start = await s.respond(makeTurn(0));
    assert.deepEqual(start, [{
      tool: 'hub_start_run',
      input: {
        pack: 'test-bed',
        inputs: { inventory: { external: 'doc:doc:bed-topology' } },
        parameters: { action: 'search', need: { devices: gold.need.devices, hours: 2 } },
      },
    }]);

    const page1 = await s.respond(makeTurn(1, searchRunText));
    assert.deepEqual(page1, [{ tool: 'hub_get_nodes', input: { reference: rec } }]);

    const acquire = await s.respond(makeTurn(2, searchPage));
    assert.deepEqual(acquire, [{
      tool: 'hub_start_run',
      input: {
        pack: 'test-bed',
        inputs: { inventory: { external: 'doc:doc:bed-topology' } },
        parameters: { action: 'acquire', bed: 'bed-a', need: { devices: gold.need.devices, hours: 2 } },
      },
    }]);

    const acquirePage1 = await s.respond(makeTurn(3, acquireRunText));
    assert.deepEqual(acquirePage1, [{ tool: 'hub_get_nodes', input: { reference: rec } }]);

    const done = await s.respond(makeTurn(4, acquirePage));
    assert.deepEqual(done, [{ text: '搜索和预订完成。' }]);
  });

  test('follows the next-page marker within a run, then moves on', async () => {
    const s = testBed(gold);
    await s.respond(makeTurn(0));
    await s.respond(makeTurn(1, searchRunText));
    const page1WithMore = `${searchPage}\n下一页：get_nodes {"reference":"${rec}","cursor":"1.0-token"}`;
    const page2 = await s.respond(makeTurn(2, page1WithMore));
    assert.deepEqual(page2, [{ tool: 'hub_get_nodes', input: { reference: rec, cursor: '1.0-token' } }]);
    const acquire = await s.respond(makeTurn(3, searchPage));
    assert.ok('tool' in acquire[0] && acquire[0].tool === 'hub_start_run');
  });

  test('finishes early when the search run gives no result reference', async () => {
    const s = testBed(gold);
    await s.respond(makeTurn(0));
    const reply = await s.respond(makeTurn(1, '出错：SOURCE_UNAVAILABLE'));
    assert.deepEqual(reply, [{ text: '搜索没有给出完整结果的引用。' }]);
  });
});
