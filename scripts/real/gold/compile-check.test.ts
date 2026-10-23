// Synthetic tests for scripts/real/gold/compile-check.ts (task case-compile B.1 & B.3).
// Tests every verification category with positive and negative cases:
//   - Contract method verification (present, disabled, param count/type)
//   - Test bed address verification (listener on trigger subnet, blind address, backend on server, off-bed address)
//     Addresses use exclusively 192.0.2.0/24 (IPv4) and 2001:db8::/32 (IPv6).
//   - Command catalog verification (existing command, out-of-range argument)
//   - Quotation verification (verbatim match, mismatched text, missing source)
//   - Verdict comparison positive and negative cases
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkBedAddress,
  checkCatalogCommand,
  checkContractMethod,
  checkVerbatimQuote,
  compareCompileVerdicts,
  compileCheck,
  computeTestBedFacts,
  parseCommandTree,
  type CompileContract,
  type ExecutionPlan,
  type RawBedManifest,
  type StepVerdict,
} from './compile-check.ts';

// Synthetic test bed manifest with documentation IP ranges
const syntheticBed: RawBedManifest = {
  name: 'synthetic-doc-bed',
  devices: [
    {
      name: 'lb-1',
      type: 'load-balancer',
      ipv4: [
        { address: '192.0.2.1', subnet: '192.0.2.0/28' }, // subnet with client trigger
        { address: '192.0.2.33', subnet: '192.0.2.32/28' }, // blind subnet (no trigger device)
      ],
      ipv6: [
        { address: '2001:db8::1', subnet: '2001:db8::/64' },
      ],
    },
    {
      name: 'client-1',
      type: 'client',
      ipv4: [
        { address: '192.0.2.2', subnet: '192.0.2.0/28' },
      ],
      ipv6: [
        { address: '2001:db8::2', subnet: '2001:db8::/64' },
      ],
    },
    {
      name: 'server-1',
      type: 'server',
      ipv4: [
        { address: '192.0.2.18', subnet: '192.0.2.16/28' },
      ],
      ipv6: [
        { address: '2001:db8:1::18', subnet: '2001:db8:1::/64' },
      ],
    },
  ],
};

const syntheticContract: CompileContract = {
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
    {
      object: 'device',
      method: 'reboot',
      disabled: true,
    },
    {
      object: 'client',
      method: 'send_http',
      params: [
        { name: 'target', type: 'string', required: true },
      ],
    },
  ],
  disabledCombinations: [
    { object: 'server', method: 'power_off' },
  ],
};

const syntheticCommandXml = `
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
`;

describe('case-compile gold checks', () => {
  const bedFacts = computeTestBedFacts(syntheticBed);
  const commandCatalog = parseCommandTree(syntheticCommandXml);

  describe('contract method verification', () => {
    test('positive: valid method and parameter types pass', () => {
      const res = checkContractMethod(syntheticContract, 'device', 'configure_vip', {
        vip: '192.0.2.1',
        port: 80,
      });
      assert.equal(res.ok, true);
      assert.equal(res.verdict, 'pass');
    });

    test('negative: unknown object or method fails', () => {
      const res = checkContractMethod(syntheticContract, 'device', 'non_existent_method');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /未在合约中定义/);
    });

    test('negative: disabled method (reboot) fails', () => {
      const res = checkContractMethod(syntheticContract, 'device', 'reboot');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /已被合约禁用/);
    });

    test('negative: missing required parameter or wrong type fails', () => {
      const missingParam = checkContractMethod(syntheticContract, 'device', 'configure_vip', {
        vip: '192.0.2.1',
      });
      assert.equal(missingParam.ok, false);
      assert.match(missingParam.reason ?? '', /缺少必填参数 port/);

      const wrongType = checkContractMethod(syntheticContract, 'device', 'configure_vip', {
        vip: '192.0.2.1',
        port: 'not-a-number',
      });
      assert.equal(wrongType.ok, false);
      assert.match(wrongType.reason ?? '', /类型不匹配/);
    });
  });

  describe('test bed address verification', () => {
    test('positive: listener on load-balancer with trigger device on subnet passes', () => {
      const res4 = checkBedAddress(bedFacts, '192.0.2.1', 'listener');
      assert.equal(res4.ok, true);
      assert.equal(res4.verdict, 'pass');

      const res6 = checkBedAddress(bedFacts, '2001:db8::1', 'listener');
      assert.equal(res6.ok, true);
      assert.equal(res6.verdict, 'pass');
    });

    test('positive: backend address on server passes', () => {
      const res = checkBedAddress(bedFacts, '192.0.2.18', 'backend');
      assert.equal(res.ok, true);
      assert.equal(res.verdict, 'pass');
    });

    test('negative: address outside bed is rejected', () => {
      // 192.0.2.250 is in documentation subnet 192.0.2.0/24 but not declared on the bed
      const res = checkBedAddress(bedFacts, '192.0.2.250', 'any');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /台架之外的地址一律拒绝/);
    });

    test('negative: blind address cannot be used as listener', () => {
      // 192.0.2.33 is on lb-1, but subnet 192.0.2.32/28 has no trigger device
      const res = checkBedAddress(bedFacts, '192.0.2.33', 'listener');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /盲地址不能当监听或虚拟地址/);
    });

    test('negative: backend address must be on server, not load-balancer', () => {
      const res = checkBedAddress(bedFacts, '192.0.2.1', 'backend');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /后端地址必须是服务器设备的地址/);
    });
  });

  describe('command catalog verification', () => {
    test('positive: command exists in tree and arguments within bounds', () => {
      const res = checkCatalogCommand(commandCatalog, '/commands/slb/pool/add', {
        name: 'test_pool',
        weight: 10,
      });
      assert.equal(res.ok, true);
      assert.equal(res.verdict, 'pass');
    });

    test('negative: command not in command tree fails', () => {
      const res = checkCatalogCommand(commandCatalog, '/commands/slb/unknown');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /命令不存在于目标构建的命令树中/);
    });

    test('negative: argument value out of declared bounds fails', () => {
      const res = checkCatalogCommand(commandCatalog, '/commands/slb/pool/add', {
        name: 'test_pool',
        weight: 150, // range is 1..100
      });
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /超出范围/);
    });
  });

  describe('expected sources quotation verification', () => {
    const sources = new Map<string, string>([
      ['src:case:1', '测试步骤：配置负载均衡策略，检查返回码应为 200 OK。'],
    ]);

    test('positive: quotation appears verbatim in source with whitespace collapsed', () => {
      const res = checkVerbatimQuote(sources, 'src:case:1', '返回码应为 200 OK');
      assert.equal(res.ok, true);
      assert.equal(res.verdict, 'pass');
    });

    test('negative: quotation not in source fails', () => {
      const res = checkVerbatimQuote(sources, 'src:case:1', '返回码应为 500 ERROR');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'fail');
      assert.match(res.reason ?? '', /不是来源.*的逐字片段/);
    });

    test('negative: missing source reference answers unknown', () => {
      const res = checkVerbatimQuote(sources, 'src:case:missing', '返回码应为 200 OK');
      assert.equal(res.ok, false);
      assert.equal(res.verdict, 'unknown');
      assert.match(res.reason ?? '', /无法读取或未绑定/);
    });
  });

  describe('compileCheck end-to-end plan verification', () => {
    test('positive: plan passes all checks and carries mandatory notes', () => {
      const plan: ExecutionPlan = {
        caseId: 'test-case-1',
        steps: [
          {
            id: 's1',
            object: 'device',
            method: 'configure_vip',
            args: { vip: '192.0.2.1', port: 80 },
            addresses: [{ ip: '192.0.2.1', role: 'listener' }],
          },
          {
            id: 's2',
            command: { path: '/commands/slb/pool/add', args: { name: 'pool_1', weight: 50 } },
          },
          {
            id: 's3',
            expectation: { sourceRef: 'src:case:1', quote: '返回码应为 200 OK' },
          },
        ],
      };

      const sources = new Map([['src:case:1', '预期：返回码应为 200 OK。']]);
      const result = compileCheck({
        plan,
        contract: syntheticContract,
        bed: syntheticBed,
        commandTreeXml: syntheticCommandXml,
        sources,
      });

      assert.equal(result.allPassed, true);
      assert.ok(result.notes.includes('按合成合约核对'));
      assert.ok(result.notes.includes('不证明在真实设备上跑得通'));
      assert.ok(result.stepVerdicts.every((v) => v.verdict === 'pass'));
    });

    test('negative: plan with a bad address reports failure', () => {
      const plan: ExecutionPlan = {
        caseId: 'test-case-2',
        steps: [
          {
            id: 's1',
            addresses: [{ ip: '192.0.2.250', role: 'any' }], // off bed
          },
        ],
      };
      const result = compileCheck({
        plan,
        contract: syntheticContract,
        bed: syntheticBed,
      });

      assert.equal(result.allPassed, false);
      assert.equal(result.stepVerdicts[0].verdict, 'fail');
      assert.match(result.stepVerdicts[0].reason ?? '', /台架之外的地址一律拒绝/);
    });
  });

  describe('verdict comparison', () => {
    test('positive: identical verdicts compare equal', () => {
      const v1: StepVerdict[] = [
        { stepIndex: 1, checkType: 'contract', verdict: 'pass' },
        { stepIndex: 2, checkType: 'address', verdict: 'pass' },
      ];
      const comp = compareCompileVerdicts(v1, v1);
      assert.equal(comp.equal, true);
      assert.equal(comp.differences.length, 0);
    });

    test('negative: differing verdicts are reported', () => {
      const hubVerdicts: StepVerdict[] = [
        { stepIndex: 1, checkType: 'contract', verdict: 'pass' },
        { stepIndex: 2, checkType: 'address', verdict: 'pass' },
      ];
      const goldVerdicts: StepVerdict[] = [
        { stepIndex: 1, checkType: 'contract', verdict: 'pass' },
        { stepIndex: 2, checkType: 'address', verdict: 'fail', reason: '台架之外' },
      ];
      const comp = compareCompileVerdicts(hubVerdicts, goldVerdicts);
      assert.equal(comp.equal, false);
      assert.ok(comp.differences.some((d) => d.includes('第 2 项判定不同')));
    });
  });
});
