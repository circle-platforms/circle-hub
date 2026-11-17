// The local command lookup (functions/cmd-lookup.ts) over a synthetic locked tree and manual (testing/lookup-fixture.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockedTree } from './catalog-selection.ts';
import { blockPositions, LOOKUP_BOUNDS, lookupHeads, lookupParam, type LookupSource } from './cmd-lookup.ts';
import { BULK, lookupFixture, REPORT_ENTRIES, SOURCE_APP, SOURCE_CLI, type LookupFixture } from '../testing/lookup-fixture.ts';

const fixture = lookupFixture();
const cli = SOURCE_CLI.slice(0, 12), app = SOURCE_APP.slice(0, 12);

function sourceOf(from: LookupFixture, options: { policy?: unknown; text?: boolean } = {}): LookupSource {
  const tree = lockedTree(from.rows, { run: from.run, root: from.root });
  if (typeof tree === 'string') throw new Error(tree);
  const blocks = new Map<string, { file: string; line: number }>();
  if (options.text !== false) for (const name of ['commands.txt', 'manual.txt']) for (const [path, at] of blockPositions(name, from.files.get(name)!.toString('utf8'))) blocks.set(path, at);
  return { tree, run: from.runJson(options.policy) as LookupSource['run'], ...(options.text === false ? {} : { blocks }) };
}
const source = sourceOf(fixture);

interface Shown { reference: string; statement: string; source: string | null; lines: string | null; node: string; partial: boolean }
/** The entries of an answer the way a reader of knowledge/*.txt takes them: a heading line, then the text to the next heading or `# ` line. */
function shown(answer: string): Shown[] {
  const lines = answer.split('\n');
  const found: Shown[] = [];
  let node = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('# /')) node = line.slice(2).split('  ')[0]!;
    if (!line.startsWith('· 引用 ')) continue;
    const heading = /^· 引用 (tree:\S+?)(?:  源 ([0-9a-f]{12}) 行 (\d+(?:-\d+)?))?(?:  适用 .*)?$/.exec(line);
    assert.ok(heading, `heading line: ${line}`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j]!.startsWith('· 引用 ') && !lines[j]!.startsWith('# '); j++) body.push(lines[j]!);
    found.push({ reference: heading[1]!, statement: body.join('\n'), source: heading[2] ?? null, lines: heading[3] ?? null, node, partial: (lines[j] ?? '').startsWith('# （上一条共') });
  }
  return found;
}
const noLine = (answer: string, text: string): void => assert.ok(!answer.split('\n').some((line) => line.includes(text)), `unexpected: ${text}`);
const hasLine = (answer: string, text: string): void => assert.ok(answer.split('\n').some((line) => line === text), `missing line: ${text}\n${answer}`);

test('heads lists every command head below a prefix with its syntax line, the next words and the count, in tree order', () => {
  const answer = lookupHeads(source, 'orbit beacon');
  hasLine(answer, 'orbit beacon add <arg1:string 1..40> <arg2:{fast|slow}> [<arg3:int 1..64="8">]');
  hasLine(answer, 'orbit beacon remove <arg1:string 1..40>');
  assert.ok(answer.indexOf('orbit beacon add <') < answer.indexOf('orbit beacon remove <'));
  assert.match(answer, /共 2 条/);
  assert.match(answer, /下一词（2 个[^）]*）：add\(1\)、remove\(1\)/);
  noLine(answer, 'orbit link');
  assert.match(answer, /--param/);
});

test('heads of a prefix that is itself a command lists it first, then the commands below it', () => {
  const answer = lookupHeads(source, 'orbit link');
  const heads = answer.split('\n').filter((line) => line.startsWith('orbit link'));
  assert.deepEqual(heads, ['orbit link <arg1:string/ipv4>', 'orbit link off', 'orbit link on']);
});

test('heads never lists more than its bound, says how many there are, and shows how to narrow', () => {
  const answer = lookupHeads(source, 'orbit bulk');
  const heads = answer.split('\n').filter((line) => /^orbit bulk w\d\d /.test(line));
  assert.equal(heads.length, LOOKUP_BOUNDS.heads);
  assert.equal(LOOKUP_BOUNDS.heads, 60);
  assert.match(answer, new RegExp(`共 ${BULK} 条，显示前 ${LOOKUP_BOUNDS.heads} 条`));
  assert.match(answer, /还有 5 条没有列出/);
  assert.match(answer, /更长的前缀/);
  assert.match(answer, /下一词（65 个，显示前 60 个/);
  noLine(answer, 'orbit bulk w64 <arg1:string>');
});

test('heads of a prefix the tree does not have names the next words by token prefix', () => {
  const answer = lookupHeads(source, 'orbit becon');
  assert.match(answer, /没有命令头 orbit becon/);
  assert.match(answer, /orbit 之下的下一词（6 个）：beacon、bulk、link、probe、report、sync/);
  assert.match(answer, /以 becon 开头的下一词：无/);
  const prefixed = lookupHeads(source, 'orbit bea');
  assert.match(prefixed, /以 bea 开头的下一词：beacon/);
});

test('param shows the definition with its enum, range and default unchanged, the tree reference to cite and the manual signature line with its locator', () => {
  const answer = lookupParam(source, 'orbit beacon add "b1" fast 3');
  assert.match(answer, /^# 命令 orbit beacon add/m);
  const definition = fixture.reference('/commands/orbit/beacon/add', 'orbit beacon add <arg1');
  const signature = fixture.reference('/commands/orbit/beacon/add', 'orbit beacon add <name>');
  const entries = shown(answer);
  const first = entries.find((entry) => entry.reference === definition)!;
  assert.equal(first.statement, fixture.statements.get(definition));
  for (const text of ['<arg2:{fast|slow}>', '[<arg3:int 1..64="8">]', '<arg1:string 1..40>', 'arg3: Retry count', '级别：CLI_LEVEL_CONFIG']) assert.ok(first.statement.includes(text), text);
  assert.equal(first.source, null);
  const second = entries.find((entry) => entry.reference === signature)!;
  assert.deepEqual([second.statement, second.source, second.lines], ['orbit beacon add <name> <mode> [retries]', cli, '120']);
  assert.ok(first.reference.startsWith(`tree:${fixture.root}/commands/orbit/beacon/add@`));
  assert.match(answer, /其余 3 个词.*按参数处理/);
  assert.doesNotMatch(answer, /种参数形式/, 'one form is the usual case and is not announced');
  assert.match(lookupParam(source, 'orbit link'), /^# 命令树有 2 种参数形式，合并写在上面的一条签名里/m);
  assert.match(lookupParam(source, 'orbit link'), /^# orbit link 之下还有 2 条命令头（下一词 off、on）：--heads 'orbit link' 列出它们的语法行。$/m);
  assert.doesNotMatch(answer, /之下还有/);
});

test('param reads the longest head of what it is given and ignores the words after it', () => {
  assert.equal(lookupParam(source, 'orbit beacon add'), lookupParam(source, 'orbit beacon add "b1" fast 3').replace(/^# 其余 3 个词.*\n/m, ''));
  assert.match(lookupParam(source, 'orbit link on'), /^# 命令 orbit link on/m);
  assert.match(lookupParam(source, 'orbit link nonesuch'), /^# 命令 orbit link/m);
});

test('param says what the tree could not read of a parameter', () => {
  const answer = lookupParam(source, 'orbit probe wait');
  assert.match(answer, /arg1.*没有解读.*\[1-x\]/);
});

test('param puts the manual window in the order of the manual lines, from the signature line to the next signature line, across nodes', () => {
  const answer = lookupParam(source, 'orbit beacon add');
  const window = shown(answer.split('# 手册对这条命令')[0]!.trimEnd()).filter((entry) => entry.node.startsWith('/manual/cli-orbit') && entry.source === cli);
  assert.deepEqual(window.map((entry) => entry.lines), ['121', '123-124', '126', '128', '129']);
  assert.deepEqual(window.map((entry) => entry.node), ['/manual/cli-orbit/信标管理', '/manual/cli-orbit/信标管理', '/manual/cli-orbit/信标管理/参数', '/manual/cli-orbit/信标管理/参数', '/manual/cli-orbit/信标管理/参数']);
  for (const entry of window) assert.equal(entry.statement, fixture.statements.get(entry.reference));
  for (const text of ['前一条命令的尾部说明。', '该命令用于删除一个信标。', 'orbit beacon purge', '该命令用于启用链路。']) assert.ok(!answer.includes(text), text);
  assert.match(answer, /共 5 条，全部显示/);
  assert.match(answer, new RegExp(`源 ${cli} 行 120`));
});

test('param points at the lines of the text files where the window can be read on, and the pointer is the line of the file', () => {
  const answer = lookupParam(source, 'orbit beacon add');
  const manual = fixture.files.get('manual.txt')!.toString('utf8').split('\n');
  const commands = fixture.files.get('commands.txt')!.toString('utf8').split('\n');
  const where = (file: string, node: string) => new RegExp(`^# ${node.replace(/[/]/g, '\\/')}  （knowledge/${file} 第 (\\d+) 行起）$`, 'm').exec(answer);
  const block = where('manual.txt', '/manual/cli-orbit/信标管理');
  assert.ok(block, answer);
  assert.equal(manual[Number(block[1]) - 1], '# /manual/cli-orbit/信标管理');
  const own = where('commands.txt', '/commands/orbit/beacon/add');
  assert.ok(own);
  assert.equal(commands[Number(own[1]) - 1], '# /commands/orbit/beacon/add');
});

test('param lists the manual rows the tree ties to the command that are not in the window', () => {
  const answer = lookupParam(source, 'orbit beacon add');
  const rows = shown(answer).filter((entry) => entry.lines === '50');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.statement, '| retries | 重试次数，1 到 64。 |');
  assert.match(answer, /不在上面的窗口里/);
  assert.equal(shown(answer).filter((entry) => entry.lines === '123-124').length, 1, 'a row of the window is shown once');
});

test('param lists the example lines of the manual that start with the command, none that belong to a longer command, none twice', () => {
  const answer = lookupParam(source, 'orbit beacon add');
  const examples = shown(answer).filter((entry) => entry.source === app);
  assert.deepEqual(examples.map((entry) => entry.lines), ['12', '14-15', '20-31']);
  assert.equal(examples[1]!.statement, 'Demo(config)#orbit beacon add "app2" fast 5\nDemo(config)#show orbit beacon');
  assert.equal(shown(answer).filter((entry) => entry.statement === 'Demo(config)#orbit beacon add "b1" fast 3').length, 1, 'the example of the window is not repeated');
  noLine(answer, '| 配置信标 | *orbit beacon add* _<name> <mode>_ |');
  // a long entry is shown by its command lines, says so, and says where it is
  const long = examples[2]!;
  assert.equal(long.partial, true);
  assert.equal(long.statement, 'orbit beacon add "x1" fast 1\norbit beacon add "x2" slow 2');
  assert.match(answer, /^# （上一条共 12 行，上面只列其中以这条命令开头的 2 行，它们在原文里不一定相邻；全文在 knowledge\/manual\.txt 第 \d+ 行起。）$/m);
  assert.match(answer, /示例里 1 条长条目只列命令行/);
  // the line numbers the answer gives are the heading lines of those examples in the text file
  const manual = fixture.files.get('manual.txt')!.toString('utf8').split('\n');
  const where = /这些示例的标注行在 knowledge\/manual\.txt 的第 ([\d、]+) 行/.exec(answer);
  assert.ok(where, answer);
  const numbers = where[1]!.split('、').map(Number);
  assert.equal(numbers.length, 3);
  for (const [at, entry] of numbers.entries()) assert.ok(manual[entry - 1]!.startsWith(`· 引用 ${examples[at]!.reference}`), `${entry}: ${manual[entry - 1]}`);
  const link = lookupParam(source, 'orbit link');
  assert.ok(!shown(link).some((entry) => entry.statement.includes('orbit link on')), 'an example of orbit link on is not an example of orbit link');
  const on = shown(lookupParam(source, 'orbit link on'));
  assert.deepEqual(on.filter((entry) => entry.statement.includes('#orbit link on')).map((entry) => `${entry.source} ${entry.lines}`), [`${cli} 204`, `${app} 16`]);
});

test('param shows the inverse the product declares: the rule, the sibling of a declared pair, and what it does not declare', () => {
  const byRule = lookupParam(source, 'orbit beacon add');
  assert.match(byRule, /^# 逆操作（产品规则：no orbit beacon add）/m);
  const inverse = fixture.reference('/commands/no/orbit/beacon/add', 'no orbit beacon add');
  assert.equal(shown(byRule).find((entry) => entry.reference === inverse)!.statement, fixture.statements.get(inverse));
  assert.match(byRule, /互逆取值 on\/off/);
  const pair = lookupParam(source, 'orbit link on');
  assert.match(pair, /^# 逆操作（产品声明的互逆取值 on\/off：同级的另一条命令 orbit link off）/m);
  assert.ok(shown(pair).some((entry) => entry.statement === 'orbit link off\n  Disable links\n  级别：CLI_LEVEL_CONFIG'));
  const removal = lookupParam(source, 'no orbit beacon add');
  assert.match(removal, /^# 逆操作（产品规则：orbit beacon add）/m);
});

test('param says when the policy names a read-only prefix or a confirmation, and when the run has no policy', () => {
  assert.match(lookupParam(source, 'show orbit beacon'), /^# 这条命令在产品声明的只读前缀 \/commands\/show 下/m);
  assert.match(lookupParam(source, 'orbit probe run x'), /^# 确认提示（产品声明）：提示符 proceed:，应答 YES/m);
  const bare = sourceOf(fixture, { policy: null });
  assert.match(lookupParam(bare, 'orbit beacon add'), /^# run\.json 里没有产品声明的命令规则（command_policy），不列逆操作和只读命令/m);
  const broken = sourceOf(fixture, { policy: { schema: 'command-policy@1', read_only: 'x' } });
  assert.match(lookupParam(broken, 'orbit beacon add'), /^# run\.json 的 command_policy 读不出来/m);
});

test('param cuts a long window at its bound, counts what is left out and says where to read on in the text file', () => {
  const answer = lookupParam(source, 'orbit report add');
  const window = shown(answer).filter((entry) => entry.source === cli && entry.node === '/manual/cli-orbit/报告管理');
  assert.equal(window.length, LOOKUP_BOUNDS.windowEntries);
  assert.equal(LOOKUP_BOUNDS.windowEntries, 40);
  assert.deepEqual(window.map((entry) => entry.lines).slice(0, 3), ['301', '302', '303']);
  assert.equal(window.at(-1)!.lines, '340');
  assert.match(answer, new RegExp(`共 ${REPORT_ENTRIES} 条，显示前 ${LOOKUP_BOUNDS.windowEntries} 条`));
  assert.ok(!answer.includes('该命令用于删除一份报告。'));
  assert.ok(!answer.includes('另一个章节里恰好落在'), 'lines of another source are not in the window');
  const next = fixture.reference('/manual/cli-orbit/报告管理', '第 41 条说明。');
  const manual = fixture.files.get('manual.txt')!.toString('utf8').split('\n');
  const pointer = /没有显示的 10 条从 knowledge\/manual\.txt 第 (\d+) 行起/.exec(answer);
  assert.ok(pointer, answer);
  assert.ok(manual[Number(pointer[1]) - 1]!.startsWith(`· 引用 ${next}`), manual[Number(pointer[1]) - 1]);
  assert.match(answer, /本次截断：手册原文窗 50 条只显示 40 条/);
});

test('param cuts a window of long entries at its character bound', () => {
  const long = lookupFixture();
  const node = long.rows.find((row) => row.path === '/manual/cli-orbit/信标管理')!;
  for (const entry of node.entries) if (entry.data.parameter?.name === 'retries') entry.statement = `| retries | ${'很长的说明'.repeat(1500)} |`;
  const huge = node.entries.find((entry: { statement: string }) => entry.statement.startsWith('该命令用于创建一个信标。'));
  huge.statement = '该命令用于创建一个信标。' + '。'.repeat(LOOKUP_BOUNDS.windowChars + 10);
  const answer = lookupParam(sourceOf(long, { text: false }), 'orbit beacon add');
  const window = shown(answer).filter((entry) => entry.source === cli && entry.node.startsWith('/manual/cli-orbit') && entry.lines !== '50');
  assert.equal(window.length, 1, 'the first entry is always shown, the rest wait for the next read');
  assert.match(answer, /字数上限/);
  assert.match(answer, /共 5 条，显示前 1 条/);
});

test('param answers a command without a manual signature line with the tree definition alone', () => {
  const answer = lookupParam(source, 'orbit sync peer');
  assert.match(answer, /^# 手册：锁定树里没有这条命令的手册签名条目/m);
  assert.equal(shown(answer).filter((entry) => entry.node.startsWith('/commands/orbit/sync/peer')).length, 1);
  assert.doesNotMatch(answer, /^# 手册原文窗/m);
});

test('param starts the window at a signature line the producer left in the manual as a bold text entry, and that line ends the window before it', () => {
  const run = lookupParam(source, 'orbit probe run "p1"');
  const first = shown(run.split('# 手册里')[0]!.trimEnd()).filter((entry) => entry.node.startsWith('/manual/'));
  assert.deepEqual(first.map((entry) => entry.lines), ['600', '601', '603']);
  assert.equal(first[0]!.statement, '**orbit probe run** *<name>*');
  assert.match(run, new RegExp(`从源 ${cli} 行 600 的签名行起，到同源下一条命令签名行（行 610）之前；共 3 条，全部显示`));
  assert.ok(!run.includes('该命令用于等待一个探针。'));
  const wait = lookupParam(source, 'orbit probe wait');
  assert.deepEqual(shown(wait.split('# 手册里')[0]!.trimEnd()).filter((entry) => entry.node.startsWith('/manual/')).map((entry) => entry.lines), ['610', '611']);
  assert.match(wait, /到同源下一条命令签名行（没有）即这份源文件末尾/);
  // the window of the command before them ends at the first of them
  assert.ok(!lookupParam(source, 'orbit report remove').includes('探针'));
});

test('param of a miss names the next words of the node the words reached, by token prefix, and the same words in another order', () => {
  const typo = lookupParam(source, 'orbit becon add');
  assert.match(typo, /^# 命令树里没有命令 orbit becon add/m);
  assert.match(typo, /走到 orbit，下一个词 becon 不是它的下一词/);
  assert.match(typo, /orbit 之下的下一词（6 个）：beacon、bulk、link、probe、report、sync/);
  assert.match(typo, /以 becon 开头的下一词：无/);
  const half = lookupParam(source, 'orbit beacon ad');
  assert.match(half, /走到 orbit beacon，下一个词 ad 不是它的下一词/);
  assert.match(half, /以 ad 开头的下一词：add/);
  const permuted = lookupParam(source, 'beacon orbit add');
  assert.match(permuted, /词相同、顺序不同或多一个词的命令头/);
  assert.ok(permuted.split('\n').indexOf('  orbit beacon add <arg1:string 1..40> <arg2:{fast|slow}> [<arg3:int 1..64="8">]') < permuted.split('\n').indexOf('  no orbit beacon add <arg1:string 1..40>'));
  const fewer = lookupParam(source, 'peer sync');
  assert.match(fewer, /^  orbit sync peer <arg1:string>$/m);
});

test('param of a first word that is no top-level word lists the top-level words, not a guess', () => {
  const answer = lookupParam(source, 'rollback peer');
  assert.match(answer, /^# 第 1 个词 rollback 不是命令树的顶层命令词/m);
  assert.match(answer, /顶层命令词共 3 个：no、orbit、show/);
  assert.match(answer, /以 rollback 开头的顶层词：无/);
  assert.match(lookupParam(source, 'orb'), /以 orb 开头的顶层词：orbit/);
  noLine(answer, '词相同、顺序不同');
});

test('param says when a word differs from the tree only in case, and does not fold it', () => {
  const first = lookupParam(source, 'ORBIT beacon add');
  assert.match(first, /^# 命令树里没有命令 ORBIT beacon add/m);
  assert.match(first, /^# 命令词区分大小写，命令树不折叠：这里的词是 orbit，写的是 ORBIT。$/m);
  assert.match(lookupParam(source, 'orbit Beacon add'), /^# 命令词区分大小写，命令树不折叠：这里的词是 beacon，写的是 Beacon。$/m);
  assert.doesNotMatch(lookupParam(source, 'orbit becon add'), /区分大小写/);
});

test('param of a branch that defines nothing lists the commands below it with their syntax lines', () => {
  const answer = lookupParam(source, 'orbit sync');
  assert.match(answer, /^# 命令树里没有命令 orbit sync：它是分支，不是完整命令/m);
  assert.match(answer, /^# orbit sync 之下的下一词（2 个，括号内是它之下的命令头数）：local\(1\)、peer\(1\)。$/m);
  hasLine(answer, 'orbit sync local');
  hasLine(answer, 'orbit sync peer <arg1:string>');
});

test('param of a command only the manual spells says so and shows the manual line it found', () => {
  const answer = lookupParam(source, 'orbit beacon purge');
  assert.match(answer, /^# 命令树里没有命令 orbit beacon purge/m);
  assert.match(answer, /手册有以它为签名行的段落，命令树没有这条命令/);
  const drift = shown(answer).find((entry) => entry.statement === '**orbit beacon purge** *<name>*')!;
  assert.deepEqual([drift.source, drift.lines], [cli, '160']);
});

test('every entry an answer shows is the entry of the tree word for word', () => {
  let total = 0;
  for (const query of ['orbit beacon add', 'orbit beacon remove', 'orbit link', 'orbit link on', 'orbit link off', 'orbit report remove', 'no orbit beacon add', 'orbit becon add', 'orbit beacon purge', 'orbit sync']) {
    for (const entry of shown(lookupParam(source, query))) {
      total++;
      const full = fixture.statements.get(entry.reference)!;
      if (entry.partial) assert.ok(entry.statement.split('\n').every((line) => full.split('\n').includes(line)), `${query}: ${entry.reference}`);
      else assert.equal(entry.statement, full, `${query}: ${entry.reference}`);
    }
  }
  for (const prefix of ['orbit', 'orbit beacon', 'orbit sync']) for (const entry of shown(lookupHeads(source, prefix))) { total++; assert.equal(entry.statement, fixture.statements.get(entry.reference)); }
  assert.ok(total >= 30, `${total} entries were compared`);
});

test('an answer is the same every time and the tree is not changed by asking', () => {
  const before = JSON.stringify(fixture.rows);
  const a = lookupParam(source, 'orbit beacon add'), b = lookupParam(source, 'orbit beacon add');
  assert.ok(a.length > 500);
  assert.equal(a, b);
  assert.equal(lookupHeads(source, 'orbit'), lookupHeads(source, 'orbit'));
  assert.equal(JSON.stringify(fixture.rows), before);
});

test('without the text files the answer has no line pointers and is otherwise the same', () => {
  const bare = lookupParam(sourceOf(fixture, { text: false }), 'orbit beacon add');
  assert.match(bare, /^# 手册原文窗/m);
  assert.ok(!/第 \d+ 行起/.test(bare) && !/标注行在 knowledge/.test(bare), 'no pointer to a line of a text file');
  assert.match(lookupParam(source, 'orbit beacon add'), /^# \/commands\/orbit\/beacon\/add  （knowledge\/commands\.txt 第 \d+ 行起）$/m);
  const pointer = (line: string): boolean => line.startsWith('# /') || line.startsWith('# （上一条共') || line.startsWith('# 这些示例的标注行在');
  assert.equal(bare.split('\n').filter((line) => !pointer(line)).join('\n'), lookupParam(source, 'orbit beacon add').split('\n').filter((line) => !pointer(line)).join('\n'));
});

test('every answer states its bounds and whether it cut anything', () => {
  assert.match(lookupParam(source, 'orbit beacon remove'), /^# 上限：手册原文窗最多 40 条或 8000 字，参数说明行最多 12 条，示例最多 6 条；本次没有截断。$/m);
  assert.match(lookupParam(source, 'orbit beacon add'), /^# 上限：手册原文窗最多 40 条或 8000 字，参数说明行最多 12 条，示例最多 6 条；本次截断：示例里 1 条长条目只列命令行。$/m);
  assert.match(lookupHeads(source, 'orbit beacon'), /^# 上限：最多列 60 条命令头；本次没有截断。$/m);
  assert.match(lookupHeads(source, 'orbit bulk'), /^# 上限：最多列 60 条命令头；本次截断：命令头 65 条只列 60 条。$/m);
});

test('a query that is not one line of command words is refused with the closed category and a next step', () => {
  assert.throws(() => lookupParam(source, 'orbit beacon add "b1'), (error: Error & { category?: string }) => error.category === 'invalid_parameters' && /引号/.test(error.message));
  assert.throws(() => lookupParam(source, '   '), (error: Error & { category?: string }) => error.category === 'invalid_parameters');
  assert.throws(() => lookupHeads(source, 'orbit "beacon"'), (error: Error & { category?: string }) => error.category === 'invalid_parameters' && /引号/.test(error.message));
});
