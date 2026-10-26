// Synthetic tests of gold/regression-doc.ts: the command-line split (quotes, multiple spaces, the `no` prefix,
// Chinese prose stops, two commands in one line, prompt prefixes, labels that are no command) and the document gold
// (defect number from the root title, cases only from tagged nodes, commands from titles and ancestor labels).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { commandTokens, normalizeHead, normalizeParameters, regressionDocGold, splitCommand } from './regression-doc.ts';

describe('splitCommand', () => {
  test('a full command with arguments, multiple spaces folded', () => {
    assert.deepEqual(splitCommand('widget health interval pool1 5'), [{ head: 'widget health interval', parameters: ['pool1', '5'] }]);
    assert.deepEqual(splitCommand('widget  health   interval   pool1   5'), [{ head: 'widget health interval', parameters: ['pool1', '5'] }]);
  });

  test('the `no` prefix belongs to the head', () => {
    assert.deepEqual(splitCommand('no widget health probe pool1'), [{ head: 'no widget health probe', parameters: ['pool1'] }]);
    assert.deepEqual(splitCommand('no relay log level'), [{ head: 'no relay log level', parameters: [] }]);
  });

  test('a quoted argument with a space stays one token', () => {
    assert.deepEqual(splitCommand('widget pool add "pool one" 80'), [{ head: 'widget pool add', parameters: ['pool one', '80'] }]);
    assert.deepEqual(splitCommand('输入“relay log level debug”后查看日志'), [{ head: 'relay log level', parameters: ['debug'] }]);
  });

  test('Chinese prose: the command is found after it and parameters stop at it', () => {
    assert.deepEqual(splitCommand('执行 widget pool add'), [{ head: 'widget pool add', parameters: [] }]);
    assert.deepEqual(splitCommand('show health pool1 显示单个池的状态'), [{ head: 'show health', parameters: ['pool1'] }]);
    assert.deepEqual(splitCommand('先执行 system backup save cfg1.txt 再执行 system backup restore cfg1.txt'), [
      { head: 'system backup save', parameters: ['cfg1.txt'] },
      { head: 'system backup restore', parameters: ['cfg1.txt'] },
    ]);
  });

  test('value words and addresses are parameters; bare lines and labels give nothing', () => {
    assert.deepEqual(splitCommand('widget health probe pool1 tcp'), [{ head: 'widget health probe', parameters: ['pool1', 'tcp'] }]);
    assert.deepEqual(splitCommand('relay endpoint add 192.0.2.21 80'), [{ head: 'relay endpoint add', parameters: ['192.0.2.21', '80'] }]);
    assert.deepEqual(splitCommand('ping 192.0.2.1'), [{ head: 'ping', parameters: ['192.0.2.1'] }]);
    assert.deepEqual(splitCommand('查看健康检查状态'), []);
    assert.deepEqual(splitCommand('061：10.6.4'), []);
  });

  test('comparison forms: case, quotes and inner spaces normalized', () => {
    assert.equal(normalizeHead('Widget  Health'), 'widget health');
    assert.deepEqual(normalizeParameters(['"Pool One"', ' 5 ']), ['pool one', '5']);
    const split = splitCommand('Widget Pool Add "Pool One" 80').map((c) => ({ head: normalizeHead(c.head), parameters: normalizeParameters(c.parameters) }));
    assert.deepEqual(split, [{ head: 'widget pool add', parameters: ['pool one', '80'] }]);
  });
});

const node = (text: string, options: { id?: string; resource?: string[]; priority?: number; children?: unknown[] } = {}): unknown => ({
  data: { text, id: options.id ?? '', resource: options.resource ?? [], priority: options.priority ?? null },
  children: options.children ?? [],
});

describe('regressionDocGold', () => {
  const map = {
    root: {
      data: { text: '缺陷160001 回归', id: 'root' },
      children: [
        node('061：10.6.4', {
          children: [
            node('003：10.6.4-R1-2026/11', {
              children: [
                node('widget health interval pool1 5', { id: 'case-1', resource: ['功能'] }),
                node('show health detail pool1', { id: 'case-2', resource: ['功能'] }),
                node('查看健康检查状态', { id: 'case-3' }),
              ],
            }),
          ],
        }),
      ],
    },
  };

  test('the defect number comes from the root title; only tagged nodes are cases', () => {
    const gold = regressionDocGold('24110', map);
    assert.deepEqual(gold.defects, ['160001']);
    assert.deepEqual(gold.cases.map((c) => c.id), ['case-1', 'case-2'], 'the untagged node is no case');
  });

  test('commands are split from the case title (labels are no command here)', () => {
    const gold = regressionDocGold('24110', map);
    assert.deepEqual(gold.cases[0].commands, [{ head: 'widget health interval', parameters: ['pool1', '5'] }]);
    assert.deepEqual(gold.cases[1].commands, [{ head: 'show health detail', parameters: ['pool1'] }]);
  });

  test('a command in an ancestor label counts for the case below it', () => {
    const withLabelCommand = {
      root: {
        data: { text: '缺陷160001 回归', id: 'root' },
        children: [node('widget pool add pool2 50', { children: [node('添加池', { id: 'case-9', resource: ['功能'] })] })],
      },
    };
    const gold = regressionDocGold('24110', withLabelCommand);
    assert.deepEqual(gold.cases[0].commands, [{ head: 'widget pool add', parameters: ['pool2', '50'] }]);
  });

  test('a document without any case is refused under default and tagged rules', () => {
    assert.throws(() => regressionDocGold('24110', { root: { data: { text: '缺陷160001 回归' }, children: [] } }), /没有用例节点/);
    assert.throws(() => regressionDocGold('24110', { root: { data: { text: '缺陷160001 回归' }, children: [] } }, { caseRule: 'tagged' }), /没有带资源标签的用例节点/);
  });

  test('marked-only document: recognized under default rule, refused under tagged rule', () => {
    const markedMap = {
      root: {
        data: { text: '缺陷160001 回归', id: 'root' },
        children: [
          node('061：10.6.4', {
            children: [
              node('003：10.6.4-R1-2026/11', {
                children: [
                  node('widget health interval pool1 5', {
                    id: 'case-marked-1',
                    priority: 2,
                    children: [node('预期：显示正常')],
                  }),
                  node('查看健康检查状态', { id: 'other-node' }),
                ],
              }),
            ],
          }),
        ],
      },
    };
    const defaultGold = regressionDocGold('24110', markedMap);
    assert.deepEqual(defaultGold.cases.map((c) => c.id), ['case-marked-1']);
    assert.deepEqual(defaultGold.cases[0].commands, [{ head: 'widget health interval', parameters: ['pool1', '5'] }]);

    assert.throws(
      () => regressionDocGold('24110', markedMap, { caseRule: 'tagged' }),
      /没有带资源标签的用例节点/,
    );
  });

  const syntheticXml = `<?xml version="1.0" encoding="ISO-8859-1"?>
<commands>
  <scope type="global">
    <menu name="gizmo">
      <menu name="relay">
        <item name="global">
          <arguments>
            <arg name="" type="IPADDR"></arg>
            <arg name="" type="U16"></arg>
          </arguments>
        </item>
      </menu>
      <menu name="pool">
        <item name="add">
          <arguments>
            <arg name="" type="STRING"></arg>
            <arg name="" type="U16"></arg>
          </arguments>
        </item>
      </menu>
    </menu>
    <menu name="widget">
      <menu name="health">
        <item name="interval">
          <arguments>
            <arg name="" type="STRING"></arg>
            <arg name="" type="U16"></arg>
          </arguments>
        </item>
      </menu>
    </menu>
  </scope>
</commands>`;

  test('Chinese text glued directly to command: longest match finds full command head', () => {
    const gluedMap = {
      root: {
        data: { text: '缺陷160002 回归', id: 'root' },
        children: [
          node('061：10.6.4', {
            children: [
              node('配置gizmo relay global 192.0.2.1 80', { id: 'case-glued-1', resource: ['功能'] }),
            ],
          }),
        ],
      },
    };
    const gold = regressionDocGold('24111', gluedMap, { commandTreeXml: syntheticXml });
    assert.deepEqual(gold.defects, ['160002']);
    assert.equal(gold.cases.length, 1);
    assert.deepEqual(gold.cases[0].commands, [
      { head: 'gizmo relay global', parameters: ['192.0.2.1', '80'] },
    ]);
  });

  test('group labels like function and stress are not mistaken for command heads and listed as unrecognized', () => {
    const groupedMap = {
      root: {
        data: { text: '缺陷160003 回归', id: 'root' },
        children: [
          node('function', {
            children: [
              node('stress', {
                children: [
                  node('widget health interval pool1 5', { id: 'case-grouped-1', resource: ['功能'] }),
                ],
              }),
            ],
          }),
        ],
      },
    };
    const gold = regressionDocGold('24112', groupedMap, { commandTreeXml: syntheticXml });
    assert.deepEqual(gold.defects, ['160003']);
    assert.equal(gold.cases.length, 1);
    assert.deepEqual(gold.cases[0].commands, [
      { head: 'widget health interval', parameters: ['pool1', '5'] },
    ]);
    assert.deepEqual(gold.cases[0].unrecognizedCommands, ['function', 'stress']);
    assert.deepEqual(gold.unrecognizedCommands, ['function', 'stress']);
  });
});
