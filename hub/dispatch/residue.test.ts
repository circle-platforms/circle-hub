import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorDefinition, ExecutorSource } from '../../contracts/src/resources.ts';
import { definition } from './testing/definition.ts';
import { probes, probesWithResidue } from './testing/probes.ts';
import { judgeResidue, residueFact, residueNext, type ResidueFinding, type ResidueProbe, type UnreadReason } from './residue.ts';

const base = { ...definition('http://127.0.0.1:1/'), allowed_tools: [...definition('http://127.0.0.1:1/').allowed_tools, 'inspect_seat'] };
const withSeats = (seat: Record<string, unknown>) => ({ ...base, probes: { ...probesWithResidue, seats: [{ ...probesWithResidue.seats[0], ...seat }] } });
const [peers, units] = ExecutorDefinition.parse(withSeats({})).probes!.seats[0].residue as [ResidueProbe, ResidueProbe];

test('a list that prints nothing but its prompt is empty, and the headers of an empty table never count', () => {
  assert.deepEqual(judgeResidue('DEMO#', units), { state: 'clean' });
  assert.deepEqual(judgeResidue('\r\n  \r\nDEMO#  \r\n', units), { state: 'clean' }, 'blank lines, padding and CRLF are not content');
  assert.deepEqual(judgeResidue('peers:\nname        address\n\nDEMO#', peers), { state: 'clean' });
  assert.deepEqual(judgeResidue('   peers:   \n\tname\taddress \nDEMO#', peers), { state: 'clean' }, 'lines are trimmed before they are matched');
});

test('any other line is residue, and the headers and the closing line are left out of it', () => {
  assert.deepEqual(judgeResidue('peers:\nname        address\nunit-b      192.0.2.7\nDEMO#', peers), { state: 'residue', lines: ['unit-b      192.0.2.7'] });
  assert.deepEqual(judgeResidue('unit-a 192.0.2.5\r\nunit-b 192.0.2.6\nDEMO#', units), { state: 'residue', lines: ['unit-a 192.0.2.5', 'unit-b 192.0.2.6'] });
  // Residue is found even when the answer was cut short: what the device did print is evidence by itself.
  assert.equal(judgeResidue('unit-b 192.0.2.6', units).state, 'residue');
});

test('an answer that cannot be shown to be complete is unread, never a clean bed', () => {
  const unread = (text: unknown, probe: ResidueProbe, why: UnreadReason) => assert.deepEqual(judgeResidue(text, probe), { state: 'unread', why }, JSON.stringify(text));
  for (const text of ['', '   \n\r\n', 'peers:\nname        address']) unread(text, peers, 'not_closed');
  for (const text of [undefined, null, 5, true, ['DEMO#'], { output: 'DEMO#' }]) unread(text, peers, 'not_text');
});

test('a declared failure line says the read failed, whatever else the answer holds', () => {
  const unread = (text: string) => assert.deepEqual(judgeResidue(text, peers), { state: 'unread', why: 'device_failure' }, text);
  unread('% rejected: no such command\nDEMO#');
  unread('unit-b 192.0.2.7\n% rejected: no such command\nDEMO#');
  // Nothing is recognised by wording: without a declared failure line the same text is residue.
  assert.equal(judgeResidue('% rejected: no such command\nDEMO#', units).state, 'residue');
});

test('declared patterns match whole lines, so a header or an alternation cannot hide a longer line', () => {
  const probe = ExecutorDefinition.parse(withSeats({ residue: [{ command: 'inspect peers', closing: 'DEMO#|END', header_patterns: ['peers:|name'] }] })).probes!.seats[0].residue![0];
  assert.deepEqual(judgeResidue('peers:\nname\nEND', probe), { state: 'clean' });
  for (const entry of ['peers: unit-b', 'name unit-b', 'DEMO# unit-b', 'my DEMO#']) assert.deepEqual(judgeResidue(`peers:\n${entry}\nEND`, probe), { state: 'residue', lines: [entry] }, entry);
});

test('the assessment retains the residue lines from the device output', () => {
  const many = Array.from({ length: 130 }, (_, n) => `entry-${n}`).join('\n');
  const kept = judgeResidue(`${many}\nDEMO#`, units);
  assert.equal(kept.state, 'residue');
  if (kept.state === 'residue') { assert.equal(kept.lines.length, 130); assert.equal(kept.lines[0], 'entry-0'); }
  const wide = judgeResidue(`${'x'.repeat(500)}\nDEMO#`, units);
  assert.equal(wide.state === 'residue' && wide.lines[0].length, 500);
});

test('the public statement names the seat and the command, never a line the device returned', () => {
  const found: ResidueFinding = { state: 'residue', lines: ['unit-b DO_NOT_DISCLOSE_REMOTE_VALUE'] };
  const fact = residueFact('synthetic-1', 'inspect peers', found);
  assert.match(fact, /设备 synthetic-1/); assert.match(fact, /inspect peers/); assert.match(fact, /残留/);
  const next = residueNext(found);
  assert.match(next, /管理员核对设备输出并清掉残留/); assert.match(next, /重新上机验证/);
  const said = new Set<string>();
  for (const why of ['refused', 'unavailable', 'not_text', 'device_failure', 'not_closed'] as const) {
    const unread = residueFact('synthetic-1', 'inspect peers', { state: 'unread', why });
    assert.match(unread, /设备 synthetic-1/); assert.match(unread, /inspect peers/); assert.match(unread, /不能判断设备上有没有残留/);
    assert.doesNotMatch(unread, /留有/, 'a read that told nothing is not reported as a residue');
    said.add(unread);
    assert.match(residueNext({ state: 'unread', why }), /重新核对测试环境/);
  }
  assert.equal(said.size, 5, 'each cause has its own statement');
  for (const text of [fact, next, ...said]) assert.doesNotMatch(text, /DO_NOT_DISCLOSE_REMOTE_VALUE/);
});

test('residue probes are an optional list on a seat, and a definition without them parses exactly as before', () => {
  const plain = { ...base, probes };
  for (const parsed of [ExecutorDefinition.parse(plain), ExecutorSource.parse(plain)]) {
    assert.deepEqual(Object.keys(parsed.probes!.seats[0]).sort(), ['index', 'interfaces', 'manifest', 'seat', 'version'], 'no key, not even an empty list, is added to a seat that declares none');
  }
  const declared = ExecutorDefinition.parse(withSeats({}));
  assert.deepEqual(declared.probes!.seats[0].residue![1], { command: 'inspect units', closing: 'DEMO#', header_patterns: [], failure_patterns: [] });
  assert.ok(ExecutorSource.safeParse(withSeats({})).success);
});

test('a residue command must be one the declared command shape admits, must not repeat, and every pattern must compile', () => {
  const refused = (seat: Record<string, unknown>, why: string, message?: RegExp) => {
    for (const schema of [ExecutorDefinition, ExecutorSource]) {
      const result = schema.safeParse(withSeats(seat));
      assert.equal(result.success, false, why);
      if (message && !result.success) assert.match(result.error.issues.map(issue => issue.message).join('；'), message, why);
    }
  };
  const good = { command: 'inspect peers', closing: 'DEMO#' };
  refused({ residue: [{ ...good, command: 'change state' }] }, 'a command outside command_pattern', /残留探测命令不符合声明的命令形状/);
  refused({ residue: [good, { ...good, closing: 'END' }] }, 'the same command twice on one seat', /残留探测命令不得重复/);
  refused({ residue: [] }, 'an empty list says nothing');
  refused({ residue: Array.from({ length: 11 }, () => good) }, 'more than ten');
  refused({ residue: [{ command: 'inspect peers' }] }, 'a probe without its closing line cannot tell empty from unread');
  refused({ residue: [{ ...good, closing: '' }] }, 'an empty closing pattern');
  refused({ residue: [{ ...good, closing: '(' }] }, 'a closing pattern that does not compile', /行模式不是有效的正则/);
  refused({ residue: [{ ...good, header_patterns: ['['] }] }, 'a header pattern that does not compile');
  refused({ residue: [{ ...good, failure_patterns: ['(?<'] }] }, 'a failure pattern that does not compile');
  refused({ residue: [{ ...good, header_patterns: Array.from({ length: 21 }, () => 'x') }] }, 'more than twenty header patterns');
  refused({ residue: [{ ...good, purpose: 'sync' }] }, 'no extra keys');
  refused({ residue: [{ ...good, command: 'x'.repeat(501) }] }, 'a command longer than the declared bound');
  assert.ok(ExecutorDefinition.safeParse(withSeats({ residue: [good, { command: 'inspect units', closing: 'DEMO#' }] })).success);
});
