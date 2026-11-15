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
function declared(
  value: Value,
  rules: Array<{ prefixes: string[]; clears?: string[]; line?: number }>,
  options: { objects?: string[]; pin?: string; order?: { rule_match: 'first_hit'; tail: string[]; before: Array<[string, string]> } } = {},
): Value {
  const doc = value.subject.contract as Doc;
  doc.cleanup = { source: SOURCE, sha256: SHA, objects: options.objects ?? ['widget-seat'], ...(options.order ? { order: options.order } : {}), rules };
  if (options.pin !== undefined) {
    doc.source_hashes = { ...doc.source_hashes, [SOURCE]: options.pin };
    doc.original.contract_sha256 = runtimeDigest(stripAdditions(doc)!);
    value.subject.profile = structuredClone(value.subject.profile) as typeof value.subject.profile;
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
  assert.match(shape!.statement, /其中 1 条配置命令由运行器自己的清理收尾，不要求逆命令（规则 fixture\/runner-cleanup-rules@cccccccccccc：自第 2 条用例开始前及整本关闭连接时，按清配对象（widget-seat）上 cmd_config 发出的命令行逐条比前缀、第一条命中即用；原合约的源文件摘要表里没有这个文件，摘要只是 Hub 侧声明，跳转机上的字节未核对）/);
  assert.match(shape!.statement, /widget-seat 的“demo pool add one 10”（规则 2，fixture\/runner-cleanup-rules 第 9 行，前缀“demo pool”）/);
  const data = (shape as { data?: { runner_cleanup?: { pinned: boolean; covered: unknown[] } } }).data;
  assert.equal(data?.runner_cleanup?.pinned, false);
  assert.equal(data?.runner_cleanup?.covered.length, 1);
});

test('a cleanup step that is no declared inverse says the runner already covers this device, so the step can go', () => {
  const value = declared(fixture(['demo pool add one 10', cleanup('demo lamp dim')]), [{ prefixes: ['demo pool'], line: 12 }]);
  const rows = checkCommandsKnown(value);
  assert.ok(rows.some((row) => row.verdict === 'refute' && row.statement.includes('清理段含没有对应执行命令的额外配置操作：“demo lamp dim”不是本设备任何配置的声明逆操作；本设备 1 条配置由运行器清理收尾，不用写清理，删掉这步')), JSON.stringify(rows));
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

test('optional clears and order are validated, disclosed when present, and refuse runner-owned save/cleanup steps placed in cleanup:true', () => {
  const order = { rule_match: 'first_hit' as const, tail: ['demo mode manual'], before: [['clear demo a', 'clear demo b'] as [string, string]] };
  const rules = [{ prefixes: ['demo pool'], clears: ['clear demo pool'], line: 17 }, { prefixes: ['demo mode'], clears: ['demo mode manual'], line: 120 }];
  const parsed = parseRuntimeContract(declared(fixture(['demo mode auto']), rules, { order }).subject.contract);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.contract.cleanup?.order, order);
  assert.deepEqual(parsed.contract.cleanup?.rules[1]?.clears, ['demo mode manual']);

  const badOrder = declared(fixture(['demo mode auto']), rules, { order });
  (badOrder.subject.contract as Doc).cleanup.order = { rule_match: 'last_hit', tail: [], before: [] };
  (badOrder.subject.contract as Doc).contract_sha256 = runtimeDigest(badOrder.subject.contract as Doc);
  assert.equal(parseRuntimeContract(badOrder.subject.contract).ok, false);

  // Used in main: accepted without inverse and discloses triggers + ordering.
  const inMain = declared(fixture(['demo mode auto', 'demo mode manual']), rules, { order });
  const [okShape] = checkContractShape(inMain);
  assert.equal(okShape?.verdict, 'support', JSON.stringify(okShape));
  assert.match(okShape!.statement, /触发 “demo mode manual”/);
  assert.match(okShape!.statement, /“demo mode manual” 放在收尾末尾/);
  assert.match(okShape!.statement, /顺序约束：“clear demo a”先于“clear demo b”/);

  // Placed in cleanup:true (both with another uncovered command or alone): refused naming runner teardown, and preserves runner_cleanup disclosure.
  for (const plan of [
    ['demo pool add one 10', cleanup('demo mode manual')],
    ['demo pool add one 10', 'demo relay enable', cleanup('demo mode manual'), cleanup('demo relay disable')],
  ]) {
    const refused = declared(fixture(plan), rules, { order });
    const rows = checkCommandsKnown(refused);
    assert.ok(rows.some((r) => r.verdict === 'refute' && r.statement.includes('这一步由执行器在收尾时做') && r.statement.includes('收尾阶段末尾执行')), JSON.stringify(rows));
    const [shapeRow] = checkContractShape(refused);
    assert.equal(shapeRow?.verdict, 'refute', JSON.stringify(shapeRow));
    assert.match(shapeRow!.statement, /其中 1 条配置命令由运行器自己的清理收尾/);
    assert.equal((shapeRow as { data?: { runner_cleanup?: { covered: unknown[] } } }).data?.runner_cleanup?.covered.length, 1);
  }

  // When an uncovered unknown gap occurs alongside a runner-covered command, runner_cleanup disclosure is still included.
  const withUnknown = declared(fixture(['demo pool add one 10', 'demo lamp bright']), [{ prefixes: ['demo pool'], clears: ['clear demo pool'], line: 17 }]);
  const [unknownRow] = checkContractShape(withUnknown);
  assert.equal(unknownRow?.verdict, 'unknown', JSON.stringify(unknownRow));
  assert.match(unknownRow!.statement, /其中 1 条配置命令由运行器自己的清理收尾/);
  assert.equal((unknownRow as { data?: { runner_cleanup?: { covered: unknown[] } } }).data?.runner_cleanup?.covered.length, 1);
});
