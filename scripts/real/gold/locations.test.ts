// Tests for scripts/real/gold/locations.ts:
// - stripPrefix: full-width / half-width colon, extra whitespace, prefix groups
// - lineKey: version line normalization
// - isModuleName: valid module names vs activity / non-module keywords
// - extractAssociatedIds: stories, bugs, leading bare numbers, exclusion of years/dates
// - evaluateLocation & locationsGold: positive cases, negative cases (missing line, missing train,
//   line-train mismatch, missing module, invalid module), nonconforming isolation
// - CLI main: exit codes, JSON output
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  evaluateLocation,
  extractAssociatedIds,
  isModuleName,
  lineKey,
  locationsGold,
  main,
  stripPrefix,
} from './locations.ts';

describe('locations gold generator', () => {
  it('stripPrefix handles full-width and half-width colons, prefix groups, and extra whitespace', () => {
    assert.deepEqual(stripPrefix('060：10.6.1'), { prefix: '060', text: '10.6.1' });
    assert.deepEqual(stripPrefix('060: 10.6.1'), { prefix: '060', text: '10.6.1' });
    assert.deepEqual(stripPrefix('060 ：   10.6.1  '), { prefix: '060', text: '10.6.1' });
    assert.deepEqual(stripPrefix('000-001-002: 10.6.1-R2-2026/7'), { prefix: '000-001-002', text: '10.6.1-R2-2026/7' });
    assert.deepEqual(stripPrefix('信标'), { prefix: null, text: '信标' });
  });

  it('lineKey normalizes line numbers dropping trailing zeros after dot', () => {
    assert.equal(lineKey('10.6.0'), '10.6');
    assert.equal(lineKey('10.6'), '10.6');
    assert.equal(lineKey('v7.1.0'), '7.1');
    assert.equal(lineKey('7.1'), '7.1');
    assert.equal(lineKey('10.6.1'), '10.6.1');
  });

  it('isModuleName validates plain module names and rejects activities and numbers', () => {
    assert.equal(isModuleName('信标'), true);
    assert.equal(isModuleName('健康检查'), true);
    assert.equal(isModuleName('SSL'), true);
    assert.equal(isModuleName('010: WebUI'), true);

    // Rejections
    assert.equal(isModuleName(''), false);
    assert.equal(isModuleName('回归测试'), false);
    assert.equal(isModuleName('用例库'), false);
    assert.equal(isModuleName('需求7001'), false);
    assert.equal(isModuleName('缺陷160578'), false);
    assert.equal(isModuleName('bug to case'), false);
    assert.equal(isModuleName('10.6.1'), false);
    assert.equal(isModuleName('10.6.1-R1-2026/5'), false);
    assert.equal(isModuleName('模块12345'), false);
  });

  it('extractAssociatedIds extracts stories, bugs, and leading bare numbers without false positives', () => {
    const title1 = '需求 17206 信标组支持TTL权重继承-测试员';
    const res1 = extractAssociatedIds(title1, ['信标']);
    assert.deepEqual(res1.stories, ['17206']);
    assert.deepEqual(res1.bugs, []);
    assert.deepEqual(res1.associatedIds, ['17206']);

    const title2 = 'bug to case 70412 & 70413 信标权重为0时的调度';
    const res2 = extractAssociatedIds(title2, ['004：7.1-R2-2026/5', '信标']);
    assert.deepEqual(res2.stories, []);
    assert.deepEqual(res2.bugs, ['70412', '70413']);
    assert.deepEqual(res2.associatedIds, ['70412', '70413']);

    const title3 = '31057-示例网关支持HTTP探活与权重联动';
    const res3 = extractAssociatedIds(title3, ['需求20931']);
    assert.deepEqual(res3.stories, ['20931']);
    assert.deepEqual(res3.bugs, []);
    assert.deepEqual(res3.associatedIds, ['20931', '31057']);

    // Four digit year at start of title should not be captured
    const title4 = '2026年信标测试用例文档';
    const res4 = extractAssociatedIds(title4, []);
    assert.deepEqual(res4.associatedIds, []);
  });

  it('evaluateLocation locates conforming documents and isolates nonconforming with exact reasons', () => {
    // 1. Fully conforming
    const goodDoc = {
      document: '900101',
      title: '需求 17206 信标测试',
      ancestors: ['030：ORBIT测试项目', '060：7.1', '004：7.1-R2-2026/5', '信标'],
    };
    const evalGood = evaluateLocation(goodDoc);
    assert.ok('location' in evalGood);
    assert.equal(evalGood.location.line, '7.1');
    assert.equal(evalGood.location.train, '7.1-R2-2026/5');
    assert.equal(evalGood.location.module, '信标');
    assert.deepEqual(evalGood.location.stories, ['17206']);

    // 2. Missing release train
    const missingTrain = {
      document: '900102',
      title: '测试',
      ancestors: ['030：项目', '060：7.1', '信标'],
    };
    const evalNoTrain = evaluateLocation(missingTrain);
    assert.ok('reason' in evalNoTrain);
    assert.equal(evalNoTrain.reason, '缺少发布火车节点');

    // 3. Train and line version mismatch
    const mismatch = {
      document: '900103',
      title: '测试',
      ancestors: ['030：项目', '060：7.1', '004：7.2-R1-2026/5', '信标'],
    };
    const evalMismatch = evaluateLocation(mismatch);
    assert.ok('reason' in evalMismatch);
    assert.match(evalMismatch.reason, /不一致/);

    // 4. Missing module layer below train
    const noModule = {
      document: '900104',
      title: '直接在火车下的文档',
      ancestors: ['030：项目', '060：7.1', '004：7.1-R2-2026/5'],
    };
    const evalNoMod = evaluateLocation(noModule);
    assert.ok('reason' in evalNoMod);
    assert.equal(evalNoMod.reason, '发布火车下面没有模块层');

    // 5. Invalid module name below train (activity keyword)
    const badMod = {
      document: '900105',
      title: '测试',
      ancestors: ['030：项目', '060：7.1', '004：7.1-R2-2026/5', '回归测试'],
    };
    const evalBadMod = evaluateLocation(badMod);
    assert.ok('reason' in evalBadMod);
    assert.match(evalBadMod.reason, /不是有效模块名/);
  });

  it('locationsGold traverses subtree and outputs locations and nonconforming lists', () => {
    const subtree = {
      root: { id: '7715', title: 'COMET' },
      children: [
        {
          id: '8100',
          label: '030：ORBIT/COMET测试项目',
          cases: [],
          children: [
            {
              id: '8110',
              label: '060：7.1',
              cases: [],
              children: [
                {
                  id: '8111',
                  label: '004：7.1-R2-2026/5',
                  cases: [],
                  children: [
                    {
                      id: '8112',
                      label: '信标',
                      cases: [],
                      children: [
                        { id: '900101', label: '需求 17206 信标组支持TTL权重继承-测试员', cases: [], children: [] },
                        { id: '900102', label: 'bug to case 70412 信标权重为0时的调度', cases: [], children: [] },
                      ],
                    },
                    {
                      id: '8113',
                      label: '健康检查',
                      cases: [],
                      children: [
                        { id: '900103', label: '31057-示例网关支持HTTP探活与权重联动', cases: [], children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: '8120',
              label: '061：7.2',
              cases: [],
              children: [
                {
                  id: '8121',
                  label: '005：7.2-R1-2026/7',
                  cases: [],
                  children: [
                    {
                      id: '8122',
                      label: '健康检查',
                      cases: [],
                      children: [
                        { id: '900104', label: '需求 19003 健康检查支持HTTPS探测', cases: [], children: [] },
                      ],
                    },
                    {
                      id: '8123',
                      label: '回归测试', // invalid module
                      cases: [],
                      children: [
                        { id: '900199', label: '非法模块下的用例', cases: [], children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const gold = locationsGold(subtree);
    assert.equal(gold.root, '7715');
    assert.equal(gold.documents.length, 4);
    assert.equal(gold.nonconforming.length, 1);

    const doc1 = gold.documents.find((d) => d.document === '900101')!;
    assert.equal(doc1.line, '7.1');
    assert.equal(doc1.train, '7.1-R2-2026/5');
    assert.equal(doc1.module, '信标');
    assert.deepEqual(doc1.stories, ['17206']);

    const doc3 = gold.documents.find((d) => d.document === '900103')!;
    assert.equal(doc3.line, '7.1');
    assert.equal(doc3.train, '7.1-R2-2026/5');
    assert.equal(doc3.module, '健康检查');
    assert.deepEqual(doc3.associatedIds, ['31057']);

    const doc4 = gold.documents.find((d) => d.document === '900104')!;
    assert.equal(doc4.line, '7.2');
    assert.equal(doc4.train, '7.2-R1-2026/7');
    assert.equal(doc4.module, '健康检查');
    assert.deepEqual(doc4.stories, ['19003']);

    const noncon = gold.nonconforming[0];
    assert.equal(noncon.document, '900199');
    assert.match(noncon.reason, /不是有效模块名/);
  });

  it('main CLI generates locations gold JSON and handles missing arguments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'locations-gold-test-'));
    try {
      const treePath = join(dir, 'tree.json');
      const outPath = join(dir, 'locations.json');

      const treeData = {
        root: { id: '7715', title: 'COMET' },
        children: [
          {
            id: '8100',
            label: '030：项目',
            children: [
              {
                id: '8110',
                label: '060：10.6.1',
                children: [
                  {
                    id: '8111',
                    label: '004：10.6.1-R2-2026/7',
                    children: [
                      {
                        id: '8112',
                        label: 'SSL',
                        children: [
                          { id: '90001', label: '需求 12345 SSL会话', children: [], cases: [] },
                        ],
                        cases: [],
                      },
                    ],
                    cases: [],
                  },
                ],
                cases: [],
              },
            ],
            cases: [],
          },
        ],
      };
      writeFileSync(treePath, JSON.stringify(treeData));

      const code = await main(['--tree', treePath, '--out', outPath]);
      assert.equal(code, 0);

      // Verify missing args returns 2
      const failCode = await main(['--tree', treePath]);
      assert.equal(failCode, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
