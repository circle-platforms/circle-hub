// Tests of the gold command-diff script (synthetic command trees, the pack's path convention):
// added, removed and modified paths; a help-text-only change is not a modification; a signature,
// parameter type or value-range change is. The gold script implements the convention itself and
// imports nothing from hub/ or packs/ (its independence is its whole value), so these tests also
// hand-compute the expected answer and compare item by item.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { commandDiff, main, parseTree, type CommandDef } from './command-diff.ts';

const earlier = `<commands>
  <scope type="config">
    <menu name="demo">
      <item name="show" help_string="显示配置">
        <arguments><arg name="all" type="STRING"/></arguments>
      </item>
      <item name="pool add" help_string="加池">
        <arguments>
          <arg name="name" type="STRING" length="1..40"/>
          <arg name="weight" type="U16" optional="yes" default_value="10"/>
        </arguments>
      </item>
      <item name="pool delete" help_string="删池">
        <arguments><arg name="name" type="STRING"/></arguments>
      </item>
      <item name="legacy" help_string="旧命令">
        <arguments><arg name="ip" type="DOTTEDIP"/></arguments>
      </item>
    </menu>
  </scope>
</commands>
`;

const later = `<commands>
  <scope type="config">
    <menu name="demo">
      <item name="show" help_string="显示全部配置（帮助文字改了，其余没动）">
        <arguments><arg name="all" type="STRING"/></arguments>
      </item>
      <item name="pool add" help_string="加池">
        <arguments>
          <arg name="name" type="STRING" length="1..64"/>
          <arg name="weight" type="U32" optional="yes" default_value="10"/>
        </arguments>
      </item>
      <item name="pool member" help_string="成员">
        <arguments><arg name="addr" type="IPADDR" limit="{tcp|udp}"/></arguments>
      </item>
      <item name="legacy" help_string="旧命令">
        <arguments><arg name="ip" type="STRING"/></arguments>
      </item>
    </menu>
    <menu name="tools">
      <item name="capture" help_string="抓包"/>
    </menu>
  </scope>
</commands>
`;

let dir: string | undefined;
const fileOf = (name: string, text: string): string => {
  dir ??= mkdtempSync(join(tmpdir(), 'gold-command-diff-'));
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('parseTree', () => {
  test('reads every full command as a path with its definition content, ignoring help text', () => {
    const defs = parseTree(earlier);
    const paths = defs.map((d: CommandDef) => d.path);
    assert.deepEqual(paths.sort(), ['/commands/demo/legacy', '/commands/demo/pool/add', '/commands/demo/pool/delete', '/commands/demo/show']);
    const show = defs.find((d: CommandDef) => d.path === '/commands/demo/show')!;
    assert.equal(show.content, 'show|arg1=all:string');
    const add = defs.find((d: CommandDef) => d.path === '/commands/demo/pool/add')!;
    assert.equal(add.content, 'pool add|arg1=name:string{1..40}|arg2=weight:int{0..65535}[optional=10]');
  });
  test('keeps two argument lists of one command as two overloads in one definition', () => {
    const two = `<commands><menu name="m"><item name="x">
      <arguments><arg name="a" type="STRING"/></arguments>
      <arguments><arg name="b" type="U16"/></arguments>
    </item></menu></commands>`;
    const defs = parseTree(two);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].content, 'x|arg1=a:string|arg1=b:int{0..65535}');
  });
  test('reads top-level commands directly under scope or wrapper elements as /commands/<name>, tolerating whitespace', () => {
    const xml = `<commands>
      <scope type="global">
        <item name="  ping  ">
          <arguments><arg name="host" type="STRING"/></arguments>
        </item>
        <wrapper>
          <item name="  reboot   quick  "/>
        </wrapper>
      </scope>
    </commands>`;
    const defs = parseTree(xml);
    const paths = defs.map((d: CommandDef) => d.path);
    assert.deepEqual(paths.sort(), ['/commands/ping', '/commands/reboot/quick']);
    const ping = defs.find((d: CommandDef) => d.path === '/commands/ping')!;
    assert.equal(ping.content, 'ping|arg1=host:string');
    const reboot = defs.find((d: CommandDef) => d.path === '/commands/reboot/quick')!;
    assert.equal(reboot.content, 'reboot quick');
  });
  test('keeps top-level commands and same-named menu commands distinct without mixing paths', () => {
    const xml = `<commands>
      <scope type="global">
        <item name="ping">
          <arguments><arg name="host" type="STRING"/></arguments>
        </item>
        <menu name="ping">
          <item name="status"/>
          <item name="ping">
            <arguments><arg name="count" type="U16"/></arguments>
          </item>
        </menu>
      </scope>
    </commands>`;
    const defs = parseTree(xml);
    const paths = defs.map((d: CommandDef) => d.path);
    assert.deepEqual(paths.sort(), ['/commands/ping', '/commands/ping/ping', '/commands/ping/status']);
    assert.equal(defs.find((d) => d.path === '/commands/ping')!.content, 'ping|arg1=host:string');
    assert.equal(defs.find((d) => d.path === '/commands/ping/ping')!.content, 'ping|arg1=count:int{0..65535}');
    assert.equal(defs.find((d) => d.path === '/commands/ping/status')!.content, 'status');
  });
});

describe('commandDiff', () => {
  test('added, removed and modified; a help-text-only change is not a modification', () => {
    const diff = commandDiff(earlier, later);
    assert.deepEqual(diff.added, ['/commands/demo/pool/member', '/commands/tools/capture']);
    assert.deepEqual(diff.removed, ['/commands/demo/pool/delete']);
    assert.deepEqual(diff.modified.sort(), ['/commands/demo/legacy', '/commands/demo/pool/add']);
    assert.ok(!diff.modified.includes('/commands/demo/show'), 'a help-text change alone is not a modification');
  });
  test('detects top-level command addition, deletion, parameter change, and preserves coexistence', () => {
    const topEarlier = `<commands>
      <scope type="global">
        <item name="ping">
          <arguments><arg name="host" type="STRING"/></arguments>
        </item>
        <item name="top_delete">
          <arguments><arg name="id" type="U32"/></arguments>
        </item>
        <item name="top_param">
          <arguments><arg name="name" type="STRING"/></arguments>
        </item>
        <menu name="ping">
          <item name="status"/>
          <item name="ping">
            <arguments><arg name="count" type="U16"/></arguments>
          </item>
        </menu>
      </scope>
    </commands>`;
    const topLater = `<commands>
      <scope type="global">
        <item name="ping">
          <arguments><arg name="host" type="STRING"/></arguments>
        </item>
        <item name="top_add">
          <arguments><arg name="opt" type="STRING"/></arguments>
        </item>
        <item name="top_param">
          <arguments>
            <arg name="name" type="STRING"/>
            <arg name="timeout" type="U16" optional="yes" default_value="30"/>
          </arguments>
        </item>
        <menu name="ping">
          <item name="status"/>
          <item name="ping">
            <arguments><arg name="count" type="U16"/></arguments>
          </item>
        </menu>
      </scope>
    </commands>`;
    const diff = commandDiff(topEarlier, topLater);
    assert.deepEqual(diff.added, ['/commands/top_add']);
    assert.deepEqual(diff.removed, ['/commands/top_delete']);
    assert.deepEqual(diff.modified, ['/commands/top_param']);
    assert.ok(!diff.modified.includes('/commands/ping'));
    assert.ok(!diff.modified.includes('/commands/ping/ping'));
    assert.ok(!diff.modified.includes('/commands/ping/status'));
  });
  test('重载只换顺序不算修改', () => {
    const reorderEarlier = `<commands>
      <menu name="m">
        <item name="x">
          <arguments><arg name="a" type="STRING"/></arguments>
          <arguments><arg name="b" type="U16"/></arguments>
        </item>
      </menu>
    </commands>`;
    const reorderLater = `<commands>
      <menu name="m">
        <item name="x">
          <arguments><arg name="b" type="U16"/></arguments>
          <arguments><arg name="a" type="STRING"/></arguments>
        </item>
      </menu>
    </commands>`;
    const diff = commandDiff(reorderEarlier, reorderLater);
    assert.deepEqual(diff, { added: [], removed: [], modified: [] });

    const separateEarlier = `<commands>
      <item name="ping"><arguments><arg name="host" type="STRING"/></arguments></item>
      <item name="ping"><arguments><arg name="count" type="U16"/></arguments></item>
    </commands>`;
    const separateLater = `<commands>
      <item name="ping"><arguments><arg name="count" type="U16"/></arguments></item>
      <item name="ping"><arguments><arg name="host" type="STRING"/></arguments></item>
    </commands>`;
    const diffSeparate = commandDiff(separateEarlier, separateLater);
    assert.deepEqual(diffSeparate, { added: [], removed: [], modified: [] });
  });
  test('equal trees give empty lists', () => {
    const diff = commandDiff(earlier, earlier);
    assert.deepEqual(diff, { added: [], removed: [], modified: [] });
  });
});

describe('main', () => {
  test('writes the three lists as JSON and exits 0; a missing file is an error naming it, not its content', async () => {
    const out = join(dir ??= mkdtempSync(join(tmpdir(), 'gold-command-diff-')), 'diff.json');
    const code = await main(['--earlier', fileOf('a.xml', earlier), '--later', fileOf('b.xml', later), '--out', out]);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(out, 'utf8'))), {
      added: ['/commands/demo/pool/member', '/commands/tools/capture'],
      removed: ['/commands/demo/pool/delete'],
      modified: ['/commands/demo/legacy', '/commands/demo/pool/add'],
    });
    const missing = await main(['--earlier', join(dir, 'nope.xml'), '--later', fileOf('b.xml', later), '--out', out]);
    assert.equal(missing, 1);
  });
  test('a deliberately different implementation would be caught: the hand-computed answer holds item by item', async () => {
    // Hand-computed from the two trees above (the pack's path convention: /commands/<words>, arguments numbered per
    // list, union types joined by /, ranges in {}, optional and default noted).
    const hand = {
      added: ['/commands/demo/pool/member', '/commands/tools/capture'],
      removed: ['/commands/demo/pool/delete'],
      modified: ['/commands/demo/legacy', '/commands/demo/pool/add'],
    };
    const diff = commandDiff(earlier, later);
    for (const key of ['added', 'removed', 'modified'] as const) {
      assert.equal(diff[key].length, hand[key].length, key);
      for (const path of hand[key]) assert.ok(diff[key].includes(path), `${key} holds ${path}`);
    }
  });
});
