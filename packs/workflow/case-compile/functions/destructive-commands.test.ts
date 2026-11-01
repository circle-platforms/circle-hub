// The runner contract's destructive commands (decision 114, as CES and the InfoTest structural gate do it): with them a
// device CLI effect that names no command scope authorises every command the locked tree resolves, except the declared
// destructive ones; with neither, device commands stay refused and the answer says why. Synthetic commands and digests only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommandsKnown, checkContractShape } from './checks.ts';
import { parseRuntimeContract, runtimeDigest } from './runtime-contract.ts';
import { fixture, cleanup } from '../testing/inverse-alternatives.ts';

type Doc = Record<string, any>;
type Value = ReturnType<typeof fixture>;
const DESTRUCTIVE = { source: 'fixture/domain_grammar.json', sha256: 'e'.repeat(64), prefixes: ['/commands/demo/relay'], segments: ['lamp'] };

/** The fixture without its command scope, with the destructive declaration (null: without one). */
function unscoped(value: Value, destructive: unknown = DESTRUCTIVE): Value {
  const doc = value.subject.contract as Doc;
  delete doc.effects.effect_0.command_scope;
  if (destructive !== null) doc.destructive = destructive;
  doc.contract_sha256 = runtimeDigest(doc);
  return value;
}
const refusals = (rows: Array<{ verdict: string; statement: string }>) => rows.filter((row) => row.verdict === 'refute').map((row) => row.statement).join('\n');

test('with destructive commands declared, an unscoped device CLI effect allows what the tree resolves and refuses the destructive ones', () => {
  const allowed = unscoped(fixture(['demo pool add one 10', cleanup('no demo pool add one')]));
  assert.deepEqual(checkCommandsKnown(allowed).map((row) => row.verdict), ['support'], JSON.stringify(checkCommandsKnown(allowed)));
  assert.match(checkContractShape(allowed)[0]!.statement, /设备命令按锁定命令树放行，只拒运行器合约声明的破坏性命令（fixture\/domain_grammar\.json@eeeeeeeeeeee，同 CES 与 InfoTest 的禁令：\/commands\/demo\/relay 及其下的命令；路径里带 lamp 的命令）/);
  const lamp = refusals(checkCommandsKnown(unscoped(fixture(['demo lamp bright']))));
  assert.match(lamp, /破坏性命令不派发：\/commands\/demo\/lamp\/bright 命中运行器合约的破坏性命令声明（路径段 lamp；来源 fixture\/domain_grammar\.json@eeeeeeeeeeee/, lamp);
  const relay = refusals(checkCommandsKnown(unscoped(fixture(['demo relay enable']))));
  assert.match(relay, /破坏性命令不派发：\/commands\/demo\/relay\/enable 命中运行器合约的破坏性命令声明（\/commands\/demo\/relay 及其下的命令/, relay);
});

test('without a command scope and without destructive commands, device commands stay refused and the answer says why', () => {
  const refused = refusals(checkCommandsKnown(unscoped(fixture(['demo pool add one 10', cleanup('no demo pool add one')]), null)));
  assert.match(refused, /合约也没有破坏性命令声明，设备命令不能按命令树放行/, refused);
});

test('a declared scope still narrows, and a destructive command is refused even inside it', () => {
  const value = fixture(['demo lamp bright']);
  const doc = value.subject.contract as Doc;
  doc.destructive = DESTRUCTIVE;
  doc.contract_sha256 = runtimeDigest(doc);
  assert.match(refusals(checkCommandsKnown(value)), /破坏性命令不派发/);
});

test('the declaration is a closed @2 addition on command-tree paths and path segments, never on wording', () => {
  for (const bad of [{ ...DESTRUCTIVE, prefixes: ['demo relay'] }, { ...DESTRUCTIVE, segments: ['Reboot!'] }, { source: 'fixture/domain_grammar.json', sha256: 'e'.repeat(64) }, { ...DESTRUCTIVE, patterns: ['\\breboot\\b'] }]) {
    const parsed = parseRuntimeContract(unscoped(fixture(['demo pool add one 10']), bad).subject.contract);
    assert.ok(!parsed.ok && parsed.problems.some((p) => p.pointer === '/destructive'), JSON.stringify(bad));
  }
  const parsed = parseRuntimeContract(unscoped(fixture(['demo pool add one 10'])).subject.contract);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.contract.destructive, { ...DESTRUCTIVE, exact: [] });
});
