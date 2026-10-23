// Tests for scripts/real/accept/case-compile.ts (case-compile scenario).
// Verifies turn progression, mandatory declaration checks, and step-by-step verdict comparisons.
// Addresses use exclusively 192.0.2.0/24 (IPv4) and 2001:db8::/32 (IPv6).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoggedTurn } from '../lib/accept.ts';
import caseCompile, { parseHubStepVerdicts, type CaseCompileGold } from './case-compile.ts';

const turnsOf = (text: string): LoggedTurn[] => [
  { index: 0, toolResults: [], tools: ['hub_start_run'] },
  { index: 1, toolResults: [{ id: 'r1', text, isError: false }], tools: [] },
];

const turn = (index: number) => ({ index, system: null, messages: [], tools: [], toolResults: [] });

describe('case-compile scenario', () => {
  const gold: CaseCompileGold = {
    caseDoc: 'case:apv:9001',
    contractDoc: 'doc:compile-contract',
    bedDoc: 'doc:test-bed-manifest',
    plan: {
      caseId: 'case-9001',
      steps: [
        {
          id: 's1',
          object: 'device',
          method: 'configure_vip',
          args: { vip: '192.0.2.1', port: 80 },
        },
        {
          id: 's2',
          addresses: [{ ip: '192.0.2.1', role: 'listener' }],
        },
        {
          id: 's3',
          command: { path: '/commands/slb/pool/add', args: { name: 'pool_1', weight: 50 } },
        },
        {
          id: 's4',
          expectation: { sourceRef: 'src:case:9001', quote: '返回 200 OK' },
        },
      ],
    },
    contract: {
      synthetic: true,
      methods: [
        {
          object: 'device',
          method: 'configure_vip',
          params: [
            { name: 'vip', type: 'string', required: true },
            { name: 'port', type: 'number', required: true },
          ],
        },
      ],
    },
    bed: {
      name: 'synthetic-bed',
      devices: [
        {
          name: 'lb-1',
          type: 'load-balancer',
          ipv4: [{ address: '192.0.2.1', subnet: '192.0.2.0/28' }],
        },
        {
          name: 'client-1',
          type: 'client',
          ipv4: [{ address: '192.0.2.2', subnet: '192.0.2.0/28' }],
        },
      ],
    },
    commandTreeXml: `
      <commands>
        <scope type="config">
          <menu name="slb">
            <item name="pool add">
              <arguments>
                <arg name="name" type="STRING" length="1..32"/>
                <arg name="weight" type="U16" range="1..100"/>
              </arguments>
            </item>
          </menu>
        </scope>
      </commands>
    `,
    sources: new Map([['src:case:9001', '步骤结果：返回 200 OK，请求成功。']]),
  };

  const scenario = caseCompile(gold);

  test('respond flow: starts run on turn 0 and completes on turn 1', () => {
    assert.deepEqual(scenario.respond(turn(0)), [
      {
        tool: 'hub_start_run',
        input: {
          pack: 'case-compile',
          inputs: {
            case: { external: 'case:apv:9001' },
            contract: { external: 'doc:compile-contract' },
            bed: { external: 'doc:test-bed-manifest' },
          },
        },
      },
    ]);
    assert.deepEqual(scenario.respond(turn(1)), [{ text: '编译核对完成。' }]);
  });

  test('parseHubStepVerdicts extracts step index, check type, and verdict', () => {
    const text = `
步骤 1（s1，合约）：通过
步骤 2（s2，地址）：通过
步骤 3（s3，命令）：通过
步骤 4（s4，引文）：不通过（引文不是原文逐字片段）
`;
    const parsed = parseHubStepVerdicts(text);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].stepIndex, 1);
    assert.equal(parsed[0].checkType, 'contract');
    assert.equal(parsed[0].verdict, 'pass');

    assert.equal(parsed[1].checkType, 'address');
    assert.equal(parsed[1].verdict, 'pass');

    assert.equal(parsed[3].checkType, 'quotation');
    assert.equal(parsed[3].verdict, 'fail');
    assert.match(parsed[3].reason ?? '', /不是原文逐字片段/);
  });

  test('positive: valid response passes all checks including mandatory notes', () => {
    const goodText = `
运行 run_01m5h9zm2nhzbz2hrfjfb6azta 完成。
按合成合约核对，不证明在真实设备上跑得通。
步骤 1（s1，合约）：通过
步骤 2（s2，地址）：通过
步骤 3（s3，命令）：通过
步骤 4（s4，引文）：通过
全部通过。
`;
    const checks = scenario.check(turnsOf(goodText));
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  });

  test('negative: missing "按合成合约核对" fails declaration check', () => {
    const missingSynthetic = `
运行 run_01m5h9zm2nhzbz2hrfjfb6azta 完成。
不证明在真实设备上跑得通。
步骤 1（s1，合约）：通过
步骤 2（s2，地址）：通过
步骤 3（s3，命令）：通过
步骤 4（s4，引文）：通过
`;
    const checks = scenario.check(turnsOf(missingSynthetic));
    assert.ok(!checks.every((c) => c.ok));
    const failedCheck = checks.find((c) => !c.ok);
    assert.match(failedCheck?.name ?? '', /合约属性声明/);
  });

  test('negative: missing "不证明在真实设备上跑得通" fails disclaimer check', () => {
    const missingDisclaimer = `
运行 run_01m5h9zm2nhzbz2hrfjfb6azta 完成。
按合成合约核对。
步骤 1（s1，合约）：通过
步骤 2（s2，地址）：通过
步骤 3（s3，命令）：通过
步骤 4（s4，引文）：通过
`;
    const checks = scenario.check(turnsOf(missingDisclaimer));
    assert.ok(!checks.every((c) => c.ok));
    const failedCheck = checks.find((c) => !c.ok);
    assert.match(failedCheck?.name ?? '', /效力范围声明/);
  });

  test('negative: differing step verdict fails agreement check', () => {
    const mismatchStep = `
运行 run_01m5h9zm2nhzbz2hrfjfb6azta 完成。
按合成合约核对，不证明在真实设备上跑得通。
步骤 1（s1，合约）：通过
步骤 2（s2，地址）：不通过（台架外地址）
步骤 3（s3，命令）：通过
步骤 4（s4，引文）：通过
`;
    const checks = scenario.check(turnsOf(mismatchStep));
    assert.ok(!checks.every((c) => c.ok));
    const stepCheck = checks.find((c) => c.name.includes('逐步核对'));
    assert.equal(stepCheck?.ok, false);
  });

  test('negative: error response fails runStarted check', () => {
    const errorText = '出错：找不到用例文档 case:apv:9001';
    const checks = scenario.check(turnsOf(errorText));
    assert.ok(!checks.every((c) => c.ok));
  });
});
