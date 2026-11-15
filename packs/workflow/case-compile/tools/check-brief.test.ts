// Unit tests for structured compile-brief@1 generation, writeStructuredBriefs, and offline check-brief verification.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  buildCompileBrief,
  COMPILE_BRIEF_SCHEMA,
  computeCompileBriefSha256,
  PRIOR_DEVICE_HISTORY_DISCLAIMER,
  validateCompileBrief,
} from '../functions/authoring-brief.ts';
import { knowledgeFiles, sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC } from '../functions/test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { readKnowledge, writeStructuredBriefs } from './authoring-brief.ts';
import { checkBriefTarget, main as checkBriefMain } from './check-brief.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = 'a'.repeat(64);
const digest = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

function sampleBatch() {
  const nodes = [
    {
      path: '/',
      reference: `tree:${ROOT}/`,
      name: '',
      level: 'branch',
      digest: digest(1),
      children: [{ name: 'commands', path: '/commands', digest: digest(2) }],
      entries: [],
    },
    {
      path: '/commands',
      reference: `tree:${ROOT}/commands`,
      name: 'commands',
      level: 'branch',
      digest: digest(2),
      children: [
        { name: 'widget', path: '/commands/widget', digest: digest(3) },
        { name: 'no', path: '/commands/no', digest: digest(4) },
      ],
      entries: [],
    },
    {
      path: '/commands/widget',
      reference: `tree:${ROOT}/commands/widget`,
      name: 'widget',
      level: 'branch',
      digest: digest(3),
      children: [{ name: 'on', path: '/commands/widget/on', digest: digest(5) }],
      entries: [],
    },
    {
      path: '/commands/widget/on',
      reference: `tree:${ROOT}/commands/widget/on`,
      name: 'on',
      level: 'leaf',
      digest: digest(5),
      children: [],
      entries: [{ entry: digest(50), kind: 'definition', statement: 'widget on', reference: `tree:${ROOT}/commands/widget/on@${digest(50)}`, data: {} }],
    },
    {
      path: '/commands/no',
      reference: `tree:${ROOT}/commands/no`,
      name: 'no',
      level: 'branch',
      digest: digest(4),
      children: [{ name: 'widget', path: '/commands/no/widget', digest: digest(6) }],
      entries: [],
    },
    {
      path: '/commands/no/widget',
      reference: `tree:${ROOT}/commands/no/widget`,
      name: 'widget',
      level: 'branch',
      digest: digest(6),
      children: [{ name: 'on', path: '/commands/no/widget/on', digest: digest(7) }],
      entries: [],
    },
    {
      path: '/commands/no/widget/on',
      reference: `tree:${ROOT}/commands/no/widget/on`,
      name: 'on',
      level: 'leaf',
      digest: digest(7),
      children: [],
      entries: [{ entry: digest(51), kind: 'definition', statement: 'no widget on', reference: `tree:${ROOT}/commands/no/widget/on@${digest(51)}`, data: {} }],
    },
  ];
  const head = { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: nodes.length, entries: 2 };
  return Buffer.from([head, ...nodes].map((line) => JSON.stringify(line)).join('\n') + '\n');
}

const ITEM_WITH_STATES = {
  id: 'doc-1:c-1',
  fields: {
    autoid: '990000000000000301',
    title: '合成用例开启部件',
    expected_nodes: [{ reference: `src:${digest(8)}/kityminder@1/n/e-1`, text: '部件开启' }],
    recomposition: {
      receipt: `rec:${digest(7)}`,
      record: {
        case: { id: 'case-0001', title: '合成用例开启部件' },
        expectation_slots: [{ slot: 'e1', atom: 'a2', reference: `src:${digest(8)}/kityminder@1/n/e-1`, text: '部件开启' }],
        atoms: [
          { id: 'a1', kind: 'action', text: 'widget on', reference: `src:${digest(8)}/kityminder@1/n/s-1` },
          { id: 'a2', kind: 'expectation', text: '部件开启', reference: `src:${digest(8)}/kityminder@1/n/e-1` },
        ],
        sources: {
          candidates: [],
          governing: [],
          states: [
            { atom: 'a1', state: 'settled', adjudicated_by: null, reason: '使用者决定：保留开启步骤', exit: null, prerequisites: null },
          ],
        },
        ledgers: { adapted: [] },
      },
    },
  },
};

test('writeStructuredBriefs generates compile-brief@1 round-1 & round-2 JSON + MD checked by check-brief without overwriting earlier rounds', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'cc-check-brief-'));
  try {
    const runDir = join(workDir, 'run1');
    for (const { name, bytes } of knowledgeFiles(sampleBatch(), RUN).outputs) {
      await mkdir(dirname(join(runDir, name)), { recursive: true });
      await writeFile(join(runDir, name), bytes);
    }
    const contractBytes = Buffer.from(JSON.stringify(signTypedRuntime(CONTRACT_DOC)));
    const profileBytes = Buffer.from(JSON.stringify(PROFILE_DOC));
    const invBytes = Buffer.from(JSON.stringify(MANIFEST_DOC));
    await mkdir(join(runDir, 'sources'));
    for (const [b, slot] of [
      [contractBytes, 'contract'],
      [profileBytes, 'profile'],
      [invBytes, 'inventory'],
    ] as const) {
      await writeFile(join(runDir, 'sources', sha256(b)), b);
      void slot;
    }
    await writeFile(
      join(runDir, 'sources.json'),
      JSON.stringify([
        { slot: 'contract', file: `sources/${sha256(contractBytes)}` },
        { slot: 'profile', file: `sources/${sha256(profileBytes)}` },
        { slot: 'inventory', file: `sources/${sha256(invBytes)}` },
      ]),
    );
    await writeFile(
      join(runDir, 'run.json'),
      JSON.stringify({
        run: RUN,
        product: 'synth-apv',
        version: '1.0.0',
        build: '1.0.0-build1',
        command_policy: { schema: 'command-policy@1', read_only: [], inverse_alternatives: [], inverse_rules: [{ source_prefix: '/commands', inverse_prefix: '/commands/no' }] },
        groups: [{ kind: 'case-compile', profile: { bed: 'bed-a' } }],
      }),
    );
    await mkdir(join(runDir, 'items'));
    await writeFile(join(runDir, 'items', '00.json'), JSON.stringify(ITEM_WITH_STATES));

    // Round 1 structured brief
    const r1 = await writeStructuredBriefs({ runDir: 'run1', cwd: workDir, round: 1, mode: 'initial' });
    assert.equal(r1.json_files.length, 1);
    const brief1 = JSON.parse(await readFile(r1.json_files[0], 'utf8'));
    assert.equal(brief1.schema, COMPILE_BRIEF_SCHEMA);
    assert.equal(brief1.prior_device_history.status, 'unavailable_from_hub');
    assert.equal(brief1.prior_device_history.disclaimer, PRIOR_DEVICE_HISTORY_DISCLAIMER);
    assert.equal(brief1.materials.prerequisites.status, 'none_declared_or_found_in_recompose');
    assert.equal(brief1.materials.prerequisites.manual_scan_required, true);
    assert.equal(brief1.materials.bed_facts.facts_status, 'extracted_from_frozen_manifest');
    assert.ok(brief1.materials.bed_facts.blind.some((b: { address: string }) => b.address === '192.0.2.130'));
    assert.equal(brief1.task.user_rulings[0].ruling, '使用者决定：保留开启步骤');

    // Verify via checkBriefTarget with expected item JSON
    const okCheck = await checkBriefTarget({
      file: 'run1/briefs/00.round-1.json',
      item: 'run1/items/00.json',
      cwd: workDir,
    });
    assert.equal(okCheck.ok, true, JSON.stringify(okCheck));

    // Round 2 rework brief + prior return + prior notes
    const plansDir = join(workDir, 'plans-r1');
    await mkdir(plansDir);
    await writeFile(
      join(plansDir, '00.json'),
      JSON.stringify({
        item: 'doc-1:c-1',
        handling: 'handled',
        slots: { plan: [{ text: 'r1', quotes: [], data: { bucket: 'bed-a', blocks: [], replacements: [], steps: [{ object: 'dut0', method: 'exec', args: ['widget on'], keywords: {} }], expects: [{ text: '部件开启', quote: { reference: 'x', text: '部件开启' }, after: 1 }] } }] },
      }),
    );
    const retDir = join(workDir, 'returns-r1');
    await mkdir(join(retDir, 'a'.repeat(12), 'cases', '990000000000000301'), { recursive: true });
    // Build a genuine 12,000-char retained session tail where early `widget on` was cut off before retention limit.
    const fillerTail = (Array.from({ length: 600 }, (_, i) => `seat#noise line ${String(i).padStart(3, '0')} ok`).join('\n') + '\nseat#\n').slice(-12_000);
    await writeFile(join(retDir, 'a'.repeat(12), 'cases', '990000000000000301', 'dut0.txt'), fillerTail);
    await writeFile(
      join(retDir, 'index.json'),
      JSON.stringify({
        schema: 'device-returns@1',
        run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb',
        jobs: [
          {
            job: 'a'.repeat(64),
            verification_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb',
            rows: [
              {
                item: '990000000000000301',
                verdict: 'fail',
                sessions: { 'dut0.txt': join('a'.repeat(12), 'cases', '990000000000000301', 'dut0.txt') },
              },
            ],
          },
        ],
      }),
    );

    // Mismatched short un-truncated returns directory refuses brief generation rather than faking 12k truncation
    const mismatchRet = join(workDir, 'returns-mismatch');
    await mkdir(join(mismatchRet, 'b'.repeat(12), 'cases', '990000000000000301'), { recursive: true });
    await writeFile(join(mismatchRet, 'b'.repeat(12), 'cases', '990000000000000301', 'dut0.txt'), 'seat#show status\nseat#\n');
    await writeFile(
      join(mismatchRet, 'index.json'),
      JSON.stringify({
        schema: 'device-returns@1',
        run: 'run_01cccccccccccccccccccccccc',
        jobs: [{ job: 'b'.repeat(64), verification_run: 'run_01cccccccccccccccccccccccc', rows: [{ item: '990000000000000301', verdict: 'fail', sessions: { 'dut0.txt': join('b'.repeat(12), 'cases', '990000000000000301', 'dut0.txt') } }] }],
      }),
    );
    await assert.rejects(
      writeStructuredBriefs({
        runDir: 'run1',
        cwd: workDir,
        round: 2,
        mode: 'rework_device',
        priorPlans: 'plans-r1',
        returns: 'returns-mismatch',
      }),
      /不属于同一次运行/,
    );

    const r2 = await writeStructuredBriefs({
      runDir: 'run1',
      cwd: workDir,
      round: 2,
      mode: 'rework_device',
      caseFilter: '00',
      priorPlans: 'plans-r1',
      returns: 'returns-r1',
    });
    assert.equal(r2.json_files.length, 1);
    const r2Check = await checkBriefTarget({ file: 'run1/briefs', item: 'run1/items/00.json', cwd: workDir });
    assert.equal(r2Check.ok, true, JSON.stringify(r2Check));
    const md2 = await readFile(r2.md_files[0], 'utf8');
    assert.ok(md2.includes('这一步的设备输出不在保留的末尾 12,000 个字符内'));
    assert.ok(md2.includes('取不到证据的步骤不要当作正确，也不要当作无关。'));

    const r3 = await writeStructuredBriefs({
      runDir: 'run1',
      cwd: workDir,
      round: 3,
      mode: 'rework_device',
      caseFilter: '00',
      priorPlans: 'plans-r1',
      returns: 'returns-r1',
    });
    const md3 = await readFile(r3.md_files[0], 'utf8');
    assert.ok(md3.includes('最后一次机会'));
    assert.ok(!md3.includes('FINAL attempt'));

    // Re-running round 1 never overwrites existing round-1 files
    const r1Again = await writeStructuredBriefs({ runDir: 'run1', cwd: workDir, round: 1, mode: 'initial' });
    assert.equal(r1Again.kept, 1);
    assert.equal(r1Again.json_files.length, 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('validateCompileBrief rejects tampered SHA, mutated atoms, missing hypothesis, or empty round-2 rework history', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'cc-brief-reject-'));
  try {
    for (const { name, bytes } of knowledgeFiles(sampleBatch(), RUN).outputs) {
      await mkdir(dirname(join(workDir, name)), { recursive: true });
      await writeFile(join(workDir, name), bytes);
    }
    const knowledge = (await readKnowledge(workDir))!;
    const good = buildCompileBrief({
      item: ITEM_WITH_STATES,
      index: '00',
      knowledge,
      policy: null,
      round: 1,
      mode: 'initial',
    })!;
    assert.equal(validateCompileBrief(good, ITEM_WITH_STATES).ok, true);

    // Tampered brief_sha256
    const badSha = structuredClone(good);
    badSha.identity.title = '被篡改的标题';
    assert.equal(validateCompileBrief(badSha).ok, false);

    // Mutated atom text even with recomputed SHA caught against expectedItem
    const badAtom = structuredClone(good);
    badAtom.materials.original_case.atoms[0].text = '改写后的动作';
    badAtom.brief_sha256 = computeCompileBriefSha256(badAtom);
    assert.equal(validateCompileBrief(badAtom, ITEM_WITH_STATES).ok, false);

    // Round 2 rework_device with empty history
    const emptyR2 = buildCompileBrief({
      item: ITEM_WITH_STATES,
      index: '00',
      knowledge,
      policy: null,
      round: 2,
      mode: 'rework_device',
      priorRounds: [],
    })!;
    assert.equal(validateCompileBrief(emptyR2).ok, false);

    // Bad CLI call exits 1 cleanly
    const origErr = process.stderr.write.bind(process.stderr);
    let errText = '';
    process.stderr.write = ((chunk: string | Uint8Array) => { errText += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      assert.equal(await checkBriefMain(['--file', 'missing-brief.json']), 1);
      assert.match(errText, /^不存在：/);
    } finally {
      process.stderr.write = origErr;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('buildCompileBrief and renderCompileBriefMd disclose contract.cleanup for runner-covered commands', async () => {
  const { CONTRACT_DOC } = await import('../functions/test-support.ts');
  const { parseRuntimeContract, runtimeDigest } = await import('../functions/runtime-contract.ts');
  const { loadRunStructuredContext, buildSingleCaseStructuredBrief } = await import('./authoring-brief.ts');
  const { renderCompileBriefMd, validateCompileBrief } = await import('../functions/authoring-brief.ts');
  const workDir = await mkdtemp(join(tmpdir(), 'cc-brief-cleanup-'));
  try {
    await mkdir(join(workDir, 'knowledge'), { recursive: true });
    await mkdir(join(workDir, 'items'), { recursive: true });
    const root = 'b'.repeat(64);
    const saveNode = {
      path: '/commands/demo/save',
      children: [],
      entries: [{ kind: 'definition', statement: 'demo save', reference: `tree:${root}/commands/demo/save@${'f'.repeat(64)}` }],
    };
    await writeFile(
      join(workDir, 'knowledge', 'nodes.jsonl'),
      [
        JSON.stringify({ schema: 'run-knowledge@1', root, composition: 'c'.repeat(64) }),
        JSON.stringify({ path: '/', children: [{ name: 'commands', path: '/commands' }], entries: [] }),
        JSON.stringify({ path: '/commands', children: [{ name: 'demo', path: '/commands/demo' }], entries: [] }),
        JSON.stringify({ path: '/commands/demo', children: [{ name: 'save', path: '/commands/demo/save' }], entries: [] }),
        JSON.stringify(saveNode),
      ].join('\n') + '\n',
    );
    await writeFile(join(workDir, 'knowledge', 'commands.txt'), '# /commands/demo/save\ndemo save\n');
    const contractDoc = structuredClone(CONTRACT_DOC) as Record<string, any>;
    contractDoc.cleanup = {
      source: 'lib/demo/clear.py',
      sha256: 'd'.repeat(64),
      objects: ['widget-seat'],
      order: { rule_match: 'first_hit', tail: ['demo save'], before: [['clear a', 'clear b']] },
      rules: [{ prefixes: ['demo save'], clears: ['demo save'], line: 120 }],
    };
    contractDoc.contract_sha256 = runtimeDigest(contractDoc);
    assert.equal(parseRuntimeContract(contractDoc).ok, true);
    await writeFile(join(workDir, 'sources.json'), JSON.stringify([{ slot: 'contract', file: 'contract.json' }]));
    await writeFile(join(workDir, 'contract.json'), JSON.stringify(contractDoc));
    await writeFile(
      join(workDir, 'run.json'),
      JSON.stringify({ run: 'run_1', command_policy: { schema: 'command-policy@1', read_only: [], inverse_rules: [], inverse_alternatives: [] } }),
    );
    const item = {
      id: 'item-save-1',
      fields: {
        autoid: 'case-save-1',
        title: '保存配置测试',
        recomposition: {
          receipt: 'rec:1',
          record: {
            schema: 'recompose-record@1',
            case: { id: 'case-save-1', title: '保存配置测试', atoms: [{ id: 'a1', text: '保存配置 demo save', quote_ref: 'src:1' }] },
            atoms: [{ id: 'a1', text: '保存配置 demo save', quote_ref: 'src:1' }],
            ledgers: { adapted: [{ atom: 'a1', action: 'keep', text: '保存配置', commands: ['demo save'] }] },
          },
        },
      },
    };
    const ctx = await loadRunStructuredContext(workDir);
    assert.ok(ctx?.runnerCleanup, 'loadRunStructuredContext must extract contract.cleanup');
    const compiled = buildSingleCaseStructuredBrief({ ctx, item, index: '00', round: 1 })!;
    assert.ok(validateCompileBrief(compiled, item).ok);
    assert.equal(compiled.materials.commands_and_manual.runner_cleanup?.objects[0], 'widget-seat');
    const cmd = compiled.materials.commands_and_manual.named_commands.find((c) => c.words === 'demo save');
    assert.equal(cmd?.inverse.kind, 'runner_cleanup');
    assert.match(cmd!.inverse.detail, /禁止把运行器收尾清理或保存命令放入 cleanup:true/);
    const md = renderCompileBriefMd(compiled);
    assert.match(md, /执行器自动清理（lib\/demo\/clear\.py@dddddddddddd）/);
    assert.match(md, /逆操作（runner_cleanup：/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
