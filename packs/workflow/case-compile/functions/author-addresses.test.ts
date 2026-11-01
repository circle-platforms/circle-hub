// Author provenance of addresses (decision 115, as InfoTest's _gate_unreachable_ips): an address the author wrote in the case's
// own command lines stays when it is not on the environment and is disclosed; an address the plan made up is refused. A
// replacement may only replace an address the locked tree parses out of the author's commands. When an inverse parses with
// several leading-parameter counts, the plan's own cleanup stands if it is one of them. Synthetic addresses only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAddresses, checkCommandsKnown } from './checks.ts';
import { runtimeDigest } from './runtime-contract.ts';
import { fixture, cleanup } from '../testing/inverse-alternatives.ts';

const OFF = '198.51.100.7', ON = '192.0.2.10';

/** The fixture with a read-only device command that takes an address, the author's case text and an optional replacement. */
function peer(planned: string, authored: string, replacements: Array<{ case: string; bed: string }> = []) {
  const value = fixture([`show demo peer ${planned}`]);
  const catalog = value.subject.command_catalog as { root: string; entries: Array<Record<string, unknown>> };
  catalog.entries.push({ words: ['show', 'demo', 'peer'], reference: `tree:${catalog.root}/commands/show/demo/peer`, signatures: [{ id: '1', reference: `src:${catalog.root}/xml@1/x/commands/peer[1]/arguments`, params: [{ name: 'address', type: 'ipv4', native_type: { name: 'IPADDR', declaration: `src:${catalog.root}/xml@1/x/commands/peer[1]/arguments/arg[1]`, grammar: 'apv-command-tree@1' } }] }] });
  const subject = value.subject as unknown as Record<string, unknown>;
  subject.case_texts = [`show demo peer ${authored}`];
  (subject.data as Record<string, unknown>).replacements = replacements;
  return value;
}

test('an off-environment address the author wrote is kept and disclosed; the same address made up by the plan is refused', () => {
  const rows = checkAddresses(peer(OFF, OFF));
  assert.equal(rows[0]?.verdict, 'support', JSON.stringify(rows));
  assert.match(rows[0]!.statement, new RegExp(`作者原文命令里的 1 个地址不在本环境可达范围里，照原值保留（同 InfoTest：只拒计划自己编的地址，作者写的写进披露），上机时可能连不通：${OFF.replaceAll('.', '\\.')}`));
  const refused = checkAddresses(peer(OFF, '203.0.113.9'));
  assert.ok(refused.some((row) => row.code === 'case-compile.address_off_bed' && /也不是作者原文命令里的地址/.test(row.statement)), JSON.stringify(refused));
});

test('a replacement may replace an address of the author’s commands, and is refused, not left unknown, for any other source', () => {
  const ok = checkAddresses(peer(ON, OFF, [{ case: OFF, bed: ON }]));
  assert.ok(!ok.some((row) => row.code === 'case-compile.replacement_invalid' || row.verdict === 'unknown'), JSON.stringify(ok));
  const rows = checkAddresses(peer(ON, OFF, [{ case: '203.0.113.9', bed: ON }]));
  assert.ok(rows.some((row) => row.verdict === 'refute' && row.code === 'case-compile.replacement_invalid' && /替换的来源 203\.0\.113\.9 不是作者命令里的地址/.test(row.statement)), JSON.stringify(rows));
  assert.ok(!rows.some((row) => row.verdict === 'unknown'), 'a plan error, not a missing maintainer fact');
});

test('an inverse with several valid leading-parameter counts accepts the cleanup the plan wrote and lists the forms otherwise', () => {
  const ambiguous = (lines: Parameters<typeof fixture>[0]) => {
    const value = fixture(lines, { schema: 'command-policy@1', read_only: ['/commands/show'], inverse_rules: [{ source_prefix: '/commands/demo/gate', inverse_prefix: '/commands/no/demo/gate' }] });
    const catalog = value.subject.command_catalog as { root: string; entries: Array<Record<string, unknown>> };
    const param = (name: string, type: string, position: number) => ({ name, type, native_type: { name: type === 'int' ? 'U16' : 'STRING', declaration: `src:${catalog.root}/xml@1/x/commands/gate/arg[${position + 1}]`, grammar: 'apv-command-tree@1' } });
    catalog.entries.push(
      { words: ['demo', 'gate', 'set'], reference: `tree:${catalog.root}/commands/demo/gate/set`, signatures: [{ id: '1', reference: `src:${catalog.root}/xml@1/x/commands/gate[1]/arguments`, params: [param('p0', 'string', 0), param('p1', 'int', 1)] }] },
      { words: ['no', 'demo', 'gate', 'set'], reference: `tree:${catalog.root}/commands/no/demo/gate/set`, signatures: [
        { id: '1', reference: `src:${catalog.root}/xml@1/x/commands/gate[2]/arguments`, params: [param('p0', 'string', 0)] },
        { id: '2', reference: `src:${catalog.root}/xml@1/x/commands/gate[3]/arguments`, params: [param('p0', 'string', 0), param('p1', 'int', 1)] },
      ] },
    );
    const doc = value.subject.contract as Record<string, any>;
    doc.effects.effect_0.command_scope = [...doc.effects.effect_0.command_scope, '/commands/demo/gate', '/commands/no/demo/gate'];
    doc.contract_sha256 = runtimeDigest(doc);
    return value;
  };
  for (const written of ['no demo gate set g1', 'no demo gate set g1 5']) {
    const rows = checkCommandsKnown(ambiguous(['demo gate set g1 5', cleanup(written)]));
    assert.deepEqual(rows.map((row) => row.verdict), ['support'], `${written}: ${JSON.stringify(rows)}`);
  }
  const wrong = checkCommandsKnown(ambiguous(['demo gate set g1 5', cleanup('no demo gate set g2')]));
  assert.ok(wrong.some((row) => row.verdict === 'refute' && /在逆序位置的清理应是下面之一：no demo gate set g1；no demo gate set g1 5/.test(row.statement)), JSON.stringify(wrong));
});
