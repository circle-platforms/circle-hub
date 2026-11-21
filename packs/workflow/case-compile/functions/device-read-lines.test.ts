import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceReadNote, readableLines, readFileName, readOnlyPrefixes } from './device-read-lines.ts';

const BRIEF = [
  '产品声明的命令规则（run.json 的 command_policy）：只读前缀 /commands/show；互逆取值 on/off。核验认逆操作的顺序：先配对。',
  '',
  '## 重组记录点到的命令（2 条）',
  '',
  '### widget name',
  '# /commands/widget/name',
  'widget name <name:string>',
  '只读前缀 /commands/show 下同样的词走到的命令：',
  '# /commands/show/widget/name',
  '· 引用 tree:aa/commands/show/widget/name@bb  源 cc 行 5',
  'show widget name',
  '  Show widget names',
  '同级命令（/commands/widget 下另有 1 个）：',
  '· widget size <n:int>',
  '',
  '### widget peer',
  '# /commands/widget/peer',
  'widget peer <ip:ipv4>',
  '只读前缀 /commands/show 下同样的词走到的命令：',
  '# /commands/show/widget/peer',
  'show widget peer <ip:ipv4>',
  '',
  '### show widget name',
  '# /commands/show/widget/name',
  'show widget name',
  '这条命令在产品声明的只读前缀下。',
  '',
  '### show statistics widget',
  '# /commands/show/statistics/widget',
  '· 引用 tree:aa/commands/show/statistics/widget@dd  源 cc 行 9',
  'show statistics widget [<arg1:string="">] [<arg2:string="all">]',
  '这条命令在产品声明的只读前缀下。',
  '',
  '### show widget log',
  '# /commands/show/widget/log',
  'show widget log <lines:int 1..100> [<level:string>]',
].join('\n');

test('only commands under a read-only prefix that take no parameter are named, once each', () => {
  assert.deepEqual(readOnlyPrefixes(BRIEF), ['/commands/show']);
  assert.deepEqual(readableLines(BRIEF), ['show widget name', 'show statistics widget'], 'the peer and log commands need a value; the configuring commands are not read-only; parameters that are all optional are left out');
  assert.deepEqual(readableLines(BRIEF.replace('只读前缀 /commands/show；', '只读前缀 无；')), [], 'a product that declares no read-only prefix has nothing to read');
  assert.deepEqual(readableLines(BRIEF, 0), []);
});

test('a path whose words are not plain command words is not a line to send', () => {
  const odd = BRIEF.replace(/widget\/name/g, 'wid%3Bget/name').replace(/show widget name/g, 'show wid;get name');
  assert.deepEqual(readableLines(odd), ['show statistics widget'], 'the odd path is left out; the plain one beside it stays');
});

test('the note names the files and gives no instruction', () => {
  assert.equal(readFileName('show widget name'), 'show-widget-name.txt');
  assert.equal(deviceReadNote('dev0', []), undefined);
  const note = deviceReadNote('dev0', [{ line: 'show widget name', file: 'device-reads/show-widget-name.txt' }])!;
  assert.match(note, /^供参考：设备 dev0 对本条简报里这些只读命令的输出，“show widget name”在 device-reads\/show-widget-name\.txt。/);
  const both = deviceReadNote('dev0', [{ line: 'show widget name', file: 'device-reads/show-widget-name.txt', lines: 3 }], [{ line: 'show widget size', file: 'device-reads/show-widget-size.txt' }])!;
  assert.match(both, /“show widget name”在 device-reads\/show-widget-name\.txt（3 行），“show widget size”读到后在 device-reads\/show-widget-size\.txt；刚发出读取的，稍后没有这个文件就是没读成。/);
  assert.doesNotMatch(both, /必须|一定|不要|不得|禁止|严禁|务必|应当|照抄/);
  assert.equal(deviceReadNote('dev0', [], []), undefined);
  assert.match(note, /不是期望值的依据$/);
  assert.match(deviceReadNote('dev0', [{ line: 'show widget name', file: 'device-reads/show-widget-name.txt', lines: 1 }])!, /show-widget-name\.txt（1 行）。/, 'the size of an output is said, so a listing that printed nothing is seen without opening it');
  assert.doesNotMatch(note, /必须|一定|不要|不得|禁止|严禁|务必|应当|照抄/);
});
