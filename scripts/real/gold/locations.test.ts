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
    assert.equal(isModuleName('缺陷160001'), false);
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
    assert.deepEqual(res2.unclassified, []);
    assert.deepEqual(res2.associatedIds, ['70412', '70413']);

    // Three convention cases: the family marks bugs, a nearer requirement marker overrides it, and 缺陷 marks bugs
    const resB2C = extractAssociatedIds('bug to case 900001 900002', []);
    assert.deepEqual(resB2C.unclassified, []);
    assert.deepEqual(resB2C.stories, []);
    assert.deepEqual(resB2C.bugs, ['900001', '900002']);
    assert.deepEqual(resB2C.associatedIds, ['900001', '900002']);

    const resB2CStory = extractAssociatedIds('bug to case 需求900003', []);
    assert.deepEqual(resB2CStory.stories, ['900003']);
    assert.deepEqual(resB2CStory.bugs, []);
    assert.deepEqual(resB2CStory.unclassified, []);
    assert.deepEqual(resB2CStory.associatedIds, ['900003']);

    const resBug = extractAssociatedIds('缺陷900004', []);
    assert.deepEqual(resBug.bugs, ['900004']);
    assert.deepEqual(resBug.stories, []);
    assert.deepEqual(resBug.unclassified, []);
    assert.deepEqual(resBug.associatedIds, ['900004']);

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

  it('handles cumulative cases in root and intermediate folders: places document in deepest folder and handles leaf document', () => {
    // Real tree shape:
    // Root lists all documents in cases: ['950001', '950002', '950003', '950004']
    // Intermediate line folder lists: ['950001', '950002', '950003']
    // Train folder lists: ['950001', '950002', '950003']
    // Module folder lists: ['950001', '950002']
    // Leaf document: 950002 is a leaf inside module folder (cases: [], children: [])
    // 950001 is only listed in module folder cases (deepest folder is module)
    // 950003 is only listed in train folder cases (deepest folder is train -> nonconforming, no module)
    // 950004 is only listed in root folder cases (deepest folder is root -> nonconforming, no line)
    const tree = {
      root: { id: '7716', title: 'FAMY' },
      cases: ['950001', '950002', '950003', '950004'],
      children: [
        {
          id: '8200',
          label: '030：FAMY测试项目',
          cases: ['950001', '950002', '950003'],
          children: [
            {
              id: '8210',
              label: '060：10.6.1',
              cases: ['950001', '950002', '950003'],
              children: [
                {
                  id: '8211',
                  label: '004：10.6.1-R2-2026/7',
                  cases: ['950001', '950002', '950003'],
                  children: [
                    {
                      id: '8212',
                      label: '信标',
                      cases: ['950001', '950002'],
                      children: [
                        {
                          id: '950002',
                          label: '需求 18002 信标探活配置',
                          cases: [],
                          children: [],
                        },
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

    const gold = locationsGold(tree);
    assert.equal(gold.root, '7716');

    // 950001: not a leaf node, listed in root, line, train, module.
    // Must fall into the deepest layer (module: 信标), NOT root!
    const doc1 = gold.documents.find((d) => d.document === '950001')!;
    assert.ok(doc1, '950001 must be located');
    assert.equal(doc1.line, '10.6.1');
    assert.equal(doc1.train, '10.6.1-R2-2026/7');
    assert.equal(doc1.module, '信标');

    // 950002: leaf document, also listed in cases of parent folders.
    // Takes its own upper path (module: 信标) and its title!
    const doc2 = gold.documents.find((d) => d.document === '950002')!;
    assert.ok(doc2, '950002 must be located');
    assert.equal(doc2.line, '10.6.1');
    assert.equal(doc2.train, '10.6.1-R2-2026/7');
    assert.equal(doc2.module, '信标');
    assert.equal(doc2.title, '需求 18002 信标探活配置');
    assert.deepEqual(doc2.stories, ['18002']);

    // 950003: deepest is train folder (no module) -> nonconforming
    const noncon3 = gold.nonconforming.find((d) => d.document === '950003')!;
    assert.ok(noncon3, '950003 must be nonconforming');
    assert.equal(noncon3.reason, '发布火车下面没有模块层');

    // 950004: deepest is root -> nonconforming
    const noncon4 = gold.nonconforming.find((d) => d.document === '950004')!;
    assert.ok(noncon4, '950004 must be nonconforming');
    assert.equal(noncon4.reason, '缺少版本线节点');
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

describe('leading-zero associated identifiers', () => {
  it('keeps the published FAMX rule: nonzero leading-zero ids retain their spelling', () => {
    assert.deepEqual(extractAssociatedIds('缺陷 0910011 合成', []).bugs, ['0910011']);
  });
  it('preserves nonzero identifiers for normalized joins and rejects all-zero runs', async () => {
    const { joinGold } = await import('./join.ts');
    const { bugIdsOf } = await import('./cases.ts');
    // Both independent extractors preserve padding; only comparison keys discard it.
    const bugs = bugIdsOf('缺陷 00910001；缺陷 000000');
    assert.deepEqual(bugs, ['00910001']);
    const joined = joinGold([{ bug: '910001', status: 'fixed', module: '', system: 'plm' }], [{ document: 'synthetic-doc', id: 'synthetic-case', title: '合成用例', defects: bugs }], { plm: [{ id: '00910001', status: 'closed' }] });
    assert.equal(joined.closed_traced, 1);
    assert.deepEqual(extractAssociatedIds('000000 合成标题', ['缺陷 00000', '需求 00']).associatedIds, []);
  });
});


describe('published bug-to-case identifier convention', () => {
  // Literal synthetic titles exercise the documented family, independently of any pack implementation.
  for (const marker of ['bug to case', 'Bug2case', 'bugtocase', 'but-to-case', 'Butocase', 'bug ro case', 'bug-to-case', 'bug_to_case']) {
    for (const separator of ['', ' ']) {
      it(`classifies ${JSON.stringify(marker + separator)} followed by an id as a defect`, () => {
        assert.deepEqual(extractAssociatedIds(`${marker}${separator}735001 合成标题`, []), {
          stories: [], bugs: ['735001'], unclassified: [], associatedIds: ['735001'],
        });
      });
    }
  }

  for (const title of ['Bug2case需求735001', 'bug to case 需求 735001', 'bugtocase story735001', 'but-to-case story 735001']) {
    it(`lets the type word nearest the id win: ${title}`, () => {
      assert.deepEqual(extractAssociatedIds(title, []), { stories: ['735001'], bugs: [], unclassified: [], associatedIds: ['735001'] });
    });
  }
  it('keeps each marker local to its following list, without retyping a neighbouring id', () => {
    assert.deepEqual(extractAssociatedIds('Bug2case735001 & 735002；story735003；PLM735004', []), {
      stories: ['735003'], bugs: ['735001', '735002'], unclassified: ['735004'], associatedIds: ['735001', '735002', '735003', '735004'],
    });
  });
  it('does not treat PLM alone as a defect marker', () => {
    for (const title of ['PLM735001', 'PLM 735001']) {
      assert.deepEqual(extractAssociatedIds(title, []), { stories: [], bugs: [], unclassified: ['735001'], associatedIds: ['735001'] });
    }
    assert.deepEqual(extractAssociatedIds('PLM Bug2case735001', []).bugs, ['735001']);
    assert.deepEqual(extractAssociatedIds('PLM story735001', []).stories, ['735001']);
  });
  for (const title of ['debugtocase735001', 'Bug2case note 735001', 'bug to case story note 735001', 'Bug2case000000', 'Bug2case7350012345']) {
    it(`does not manufacture a typed id from ${JSON.stringify(title)}`, () => {
      assert.deepEqual(extractAssociatedIds(title, []), { stories: [], bugs: [], unclassified: [], associatedIds: [] });
    });
  }
  it('does not let a trailing family phrase classify a leading bare id retroactively', () => {
    assert.deepEqual(extractAssociatedIds('735001 合成标题 Bug2case', []), { stories: [], bugs: [], unclassified: ['735001'], associatedIds: ['735001'] });
  });
  it('retains padding while typed folder evidence classifies a bare title id', () => {
    assert.deepEqual(extractAssociatedIds('0735001 合成标题', ['Bug2case 0735001']), { stories: [], bugs: ['0735001'], unclassified: [], associatedIds: ['0735001'] });
  });
  it('carries the independent classification into a conforming document location', () => {
    const result = evaluateLocation({ document: 'synthetic-document', title: 'Butocase735001 合成文档', ancestors: ['10.6.1', '10.6.1-R2', 'Synthetic Module'] });
    assert.equal(result.location.conforming, true);
    assert.deepEqual(result.location.bugs, ['735001']);
    assert.deepEqual(result.location.unclassified, []);
  });
});
