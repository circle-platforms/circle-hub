// The runner's own cleanup (decision 112): the runner clears every listed object at each case boundary and at the end of a
// workbook, from the prefix rules of its clear source tested against each sent line, first hit. A live configuration command
// such a rule covers needs no inverse in the case; any other still does, and an explicit inverse is still accepted.
// Synthetic commands, objects and digests only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommandsKnown, checkContractShape } from './checks.ts';
import { parseRuntimeContract, runtimeDigest, stripAdditions } from './runtime-contract.ts';
import { fixture, cleanup } from '../testing/inverse-alternatives.ts';

const SOURCE = 'fixture/runner-cleanup-rules', SHA = 'c'.repeat(64);
type Value = ReturnType<typeof fixture>;
type Doc = Record<string, any>;

/** The fixture with a runner cleanup declaration; `pin` also records the source digest in the original contract. */
function declared(value: Value, rules: Array<{ prefixes: string[]; line?: number }>, options: { objects?: string[]; pin?: string } = {}): Value {
  const doc = value.subject.contract as Doc;
  doc.cleanup = { source: SOURCE, sha256: SHA, objects: options.objects ?? ['widget-seat'], rules };
  if (options.pin !== undefined) {
    doc.source_hashes = { ...doc.source_hashes, [SOURCE]: options.pin };
    doc.original.contract_sha256 = runtimeDigest(stripAdditions(doc)!);
    (value.subject.profile as Doc).runtime.contract_sha256 = doc.original.contract_sha256;
  }
  doc.contract_sha256 = runtimeDigest(doc);
  return value;
}
const verdicts = (rows: Array<{ verdict: string }>) => rows.map((row) => row.verdict);

test('a configuration command a runner rule covers needs no inverse, and the contract check says which rule and how far it is pinned', () => {
  const bare = fixture(['demo pool add one 10']);
  assert.ok(checkCommandsKnown(bare).some((row) => row.verdict === 'refute' && row.statement.includes('缺同设备、逆序的清理操作')), 'without the declaration the inverse is required');
  const value = declared(fixture(['demo pool add one 10']), [{ prefixes: ['demo lamp'], line: 7 }, { prefixes: ['demo pool'], line: 9 }]);
  assert.deepEqual(verdicts(checkCommandsKnown(value)), ['support'], JSON.stringify(checkCommandsKnown(value)));
  const [shape] = checkContractShape(value);
  assert.equal(shape?.verdict, 'support', JSON.stringify(shape));
  assert.match(shape!.statement, /其中 1 条配置命令由运行器自己的清理收尾，不要求逆命令（规则 fixture\/runner-cleanup-rules@cccccccccccc：每个用例开始前和整本结束时按发过的命令行逐条比前缀、第一条命中即用；原合约的源文件摘要表里没有这个文件，摘要只是 Hub 侧声明，跳转机上的字节未核对）/);
  assert.match(shape!.statement, /widget-seat 的“demo pool add one 10”（规则 2，fixture\/runner-cleanup-rules 第 9 行，前缀“demo pool”）/);
  const data = (shape as { data?: { runner_cleanup?: { pinned: boolean; covered: unknown[] } } }).data;
  assert.equal(data?.runner_cleanup?.pinned, false);
  assert.equal(data?.runner_cleanup?.covered.length, 1);
});

test('a command outside every rule, or on an object the runner does not clear, still needs its inverse', () => {
  const outside = declared(fixture(['demo pool add one 10']), [{ prefixes: ['demo lamp'] }]);
  assert.ok(checkCommandsKnown(outside).some((row) => row.verdict === 'refute' && row.statement.includes('缺同设备、逆序的清理操作')), JSON.stringify(checkCommandsKnown(outside)));
  const other = declared(fixture(['demo pool add one 10']), [{ prefixes: ['demo pool'] }], { objects: ['widget-host'] });
  assert.ok(checkCommandsKnown(other).some((row) => row.verdict === 'refute' && row.statement.includes('缺同设备、逆序的清理操作')), JSON.stringify(checkCommandsKnown(other)));
});

test('an explicit inverse of a covered command is still accepted, and uncovered ones keep their reverse-order pairing', () => {
  const explicit = declared(fixture(['demo pool add one 10', cleanup('no demo pool add one')]), [{ prefixes: ['demo pool'] }]);
  assert.deepEqual(verdicts(checkCommandsKnown(explicit)), ['support'], JSON.stringify(checkCommandsKnown(explicit)));
  assert.doesNotMatch(checkContractShape(explicit)[0]!.statement, /由运行器自己的清理收尾/, 'the case undid it itself');
  for (const lines of [['demo pool add one 10', 'demo feature on', cleanup('demo feature off')], ['demo feature on', 'demo pool add one 10', cleanup('demo feature off')]]) {
    const mixed = declared(fixture(lines), [{ prefixes: ['demo pool'] }]);
    assert.deepEqual(verdicts(checkCommandsKnown(mixed)), ['support'], JSON.stringify(checkCommandsKnown(mixed)));
  }
  const missing = declared(fixture(['demo pool add one 10', 'demo feature on']), [{ prefixes: ['demo pool'] }]);
  assert.ok(checkCommandsKnown(missing).some((row) => row.verdict === 'refute' && row.statement.includes('demo/feature')), 'the uncovered switch still needs its declared inverse');
});

test('the declaration is a closed @2 addition: pinned by the original source digest when recorded, refused when it differs', () => {
  const pinned = declared(fixture(['demo pool add one 10']), [{ prefixes: ['demo pool'] }], { pin: SHA });
  const parsed = parseRuntimeContract(pinned.subject.contract);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.contract.cleanup?.pinned, true);
  assert.equal(parsed.contract.pinned.identity, (pinned.subject.contract as Doc).original.contract_sha256, 'the gateway identity is the original one, without the addition');
  assert.match(checkContractShape(pinned)[0]!.statement, /原合约的源文件摘要表记了同一摘要/);
  const differs = declared(fixture(['demo pool add one 10']), [{ prefixes: ['demo pool'] }], { pin: 'd'.repeat(64) });
  const refused = parseRuntimeContract(differs.subject.contract);
  assert.ok(!refused.ok && refused.problems.some((p) => p.pointer === '/cleanup/sha256'), JSON.stringify(refused));
  const unknownObject = declared(fixture(['demo pool add one 10']), [{ prefixes: ['demo pool'] }], { objects: ['widget-absent'] });
  const absent = parseRuntimeContract(unknownObject.subject.contract);
  assert.ok(!absent.ok && absent.problems.some((p) => p.pointer === '/cleanup/objects/0'), JSON.stringify(absent));
  const extra = declared(fixture(['demo pool add one 10']), [{ prefixes: ['demo pool'] }]);
  (extra.subject.contract as Doc).cleanup.commands = ['clear demo all'];
  (extra.subject.contract as Doc).contract_sha256 = runtimeDigest(extra.subject.contract as Doc);
  const closed = parseRuntimeContract(extra.subject.contract);
  assert.ok(!closed.ok && closed.problems.some((p) => p.pointer === '/cleanup'), 'clear commands are never declared');
});
