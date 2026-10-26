// (g) Every tool's input and output, success and error answers, checked twice: with the zod shape (what the server runs) and
// with the published schema in tools.json the way an MCP client checks it (the SDK's Ajv validator). A case marked
// `refinement` is one the published schema cannot express: zod refuses it, the client's validator lets it through.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { z } from 'zod';
import { PARTITION } from '../generated/vocabulary.ts';
import { accepted, acceptedCounts, copy, H, H2, H3, notAccepted, packSummary, partitions, RUN, submission, summary, TRACE, TRACE2, unavailable } from './fixtures.ts';
import { MAX_UPLOAD_BASE64_LENGTH, TOOLS } from './tools.ts';

type Case = { why: string; value: unknown; refinement?: true };
type Sides = { valid: Case[]; invalid: Case[] };
type JsonSchema = Parameters<AjvJsonSchemaValidator['getValidator']>[0];

const published = JSON.parse(readFileSync(new URL('../generated/tools.json', import.meta.url), 'utf8')) as { name: string; inputSchema: JsonSchema; outputSchema: JsonSchema }[];
const ajv = new AjvJsonSchemaValidator();
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const ok = { call_result: 'ok', errors: [], trace: TRACE };
const failed = (error: object = unavailable) => ({ call_result: 'error', errors: [error], trace: TRACE });
const malformedRun = { code: 'SUBMISSION_SCHEMA_VIOLATION', message: '提交结构或条目投影违规', fix: '按槽位模式改正后重交', path: '/run' };

const node = {
  path: '/commands/show',
  reference: `tree:${H}/commands/show`,
  name: 'show',
  level: 'branch',
  digest: H2,
  children: [{ name: 'item', path: '/commands/show/item', digest: H3 }],
  entries: [{ entry: H3, kind: 'definition', statement: 'show item', reference: `tree:${H}/commands/show@${H3}`, applicability: '2.1', data: { signatures: [] } }],
};

const CASES: Record<string, { input: Sides; output: Sides }> = {
  list_task_packs: {
    input: {
      valid: [{ why: 'no filter', value: {} }, { why: 'by kind', value: { kind: 'workflow' } }],
      invalid: [{ why: 'kind outside the vocabulary', value: { kind: 'plugin' } }, { why: 'misspelled key', value: { knd: 'workflow' } }],
    },
    output: {
      valid: [{ why: 'packs', value: { ...ok, packs: [packSummary] } }, { why: 'error with the empty list', value: { ...failed(), packs: [] } }],
      invalid: [
        { why: 'an error answer that lists packs', value: { ...failed(), packs: [packSummary] }, refinement: true },
        { why: 'an error without a code', value: { ...ok, call_result: 'error', packs: [] }, refinement: true },
        { why: 'extra key', value: { ...ok, packs: [], total: 1 } },
      ],
    },
  },
  upload_file: {
    input: {
      valid: [{ why: 'base64 content', value: { file_path: base64('{"root":{"data":{"id":"n1"}}}'), media_type: 'application/json', name: 'map.json' } }],
      invalid: [
        { why: 'a local path the client did not replace', value: { file_path: '/synthetic-homes/alice/review/map.json' } },
        { why: 'bad padding', value: { file_path: 'abc' }, refinement: true },
        { why: 'line break', value: { file_path: 'YWJj\nZGVm' } },
        { why: 'empty', value: { file_path: '' } },
        { why: 'over the upload cap', value: { file_path: 'A'.repeat(MAX_UPLOAD_BASE64_LENGTH + 4) } },
        { why: 'misspelled key', value: { file_path: base64('x'), mediatype: 'text/plain' } },
      ],
    },
    output: {
      valid: [
        { why: 'accepted', value: { ...ok, acceptance: 'accepted', reference: `src:${H}`, sha256: H, size: 31, media_type: 'application/json', structure: { nodes: 3 } } },
        { why: 'not accepted: credential found', value: { ...failed({ code: 'CREDENTIAL_IN_UPLOAD', message: '上传里扫出明文凭据', fix: '去掉凭据后重传' }), acceptance: 'not_accepted', sha256: H } },
        { why: 'neutral answer', value: { ...failed(), acceptance: 'not_accepted' } },
      ],
      invalid: [
        { why: 'accepted without a reference', value: { ...ok, acceptance: 'accepted', sha256: H, size: 1 }, refinement: true },
        { why: 'reference of other bytes', value: { ...ok, acceptance: 'accepted', reference: `src:${H2}`, sha256: H, size: 1 }, refinement: true },
        { why: 'not accepted with a reference', value: { ...failed(), acceptance: 'not_accepted', reference: `src:${H}` }, refinement: true },
        { why: 'accepted but an error', value: { ...failed(), acceptance: 'accepted' }, refinement: true },
        { why: 'reference that is not src', value: { ...ok, acceptance: 'accepted', reference: `tree:${H}/`, sha256: H, size: 1 } },
        { why: 'receipt missing', value: { ...ok, reference: `src:${H}`, sha256: H, size: 1 } },
      ],
    },
  },
  start_run: {
    input: {
      valid: [
        { why: 'an uploaded input and a key', value: { pack: 'review@1.0.0', inputs: { mindmap: { reference: `src:${H}` } }, client_key: 'k-1' } },
        { why: 'external inputs and a build', value: { pack: 'review', build: 'b-7', inputs: { stories: [{ external: 'tracker:story:42' }, { reference: `src:${H2}` }] }, parameters: { strict: true }, predecessor: RUN } },
      ],
      invalid: [
        { why: 'misspelled build: the pack rule would pick another build', value: { pack: 'review', inputs: {}, buidl: 'b-7' } },
        { why: 'misspelled client_key: a retry would start a second run', value: { pack: 'review', inputs: {}, clientKey: 'k-1' } },
        { why: 'inputs missing', value: { pack: 'review' } },
        { why: 'empty pack', value: { pack: '', inputs: {} } },
        { why: 'empty client key', value: { pack: 'review', inputs: {}, client_key: '' } },
        { why: 'NUL in a client key', value: { pack: 'review', inputs: {}, client_key: 'a\u0000b' }, refinement: true },
        { why: 'binding with two keys', value: { pack: 'review', inputs: { a: { reference: `src:${H}`, external: 'tracker:story:1' } } } },
      ],
    },
    output: {
      valid: [
        { why: 'the run', value: { ...ok, run: summary } },
        { why: 'the run with the result the Hub computed', value: { ...ok, run: summary, result: { reference: `rec:${H}`, counts: { delivered: 3, rejected: 0, quarantined: 0, incomplete: 1, unknown: 1 } } } },
        { why: 'neutral answer', value: failed() },
      ],
      invalid: [
        { why: 'ok without the run', value: ok, refinement: true },
        { why: 'a result without a run', value: { ...failed(), result: { reference: `rec:${H}`, counts: { delivered: 0, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 } } }, refinement: true },
        { why: 'a result that points at a source', value: { ...ok, run: summary, result: { reference: `src:${H}`, counts: { delivered: 0, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 } } } },
        { why: 'an error with a run', value: { ...failed(), run: summary }, refinement: true },
        { why: 'run with an unknown key', value: { ...ok, run: { ...summary, phase: 'running' } } },
      ],
    },
  },
  get_nodes: {
    input: {
      valid: [{ why: 'subtrees', value: { run: RUN, paths: ['/', '/commands/show%20item'], depth: 2 } }, { why: 'a reference', value: { reference: `src:${H}` } }],
      invalid: [
        { why: 'relative path', value: { paths: ['commands'] } },
        { why: 'raw space', value: { paths: ['/a b'] } },
        { why: 'trailing slash', value: { paths: ['/a/'] } },
        { why: 'too deep', value: { depth: 7 } },
        { why: 'misspelled key', value: { run: RUN, pathz: ['/'] } },
      ],
    },
    output: {
      valid: [
        { why: 'nodes', value: { ...ok, root: H, nodes: [node] } },
        { why: 'the root node', value: { ...ok, root: H, nodes: [{ ...node, path: '/', reference: `tree:${H}/`, entries: [{ ...node.entries[0], reference: `tree:${H}/@${H3}` }] }] } },
        { why: 'model readable content', value: { ...ok, content: { reference: `src:${H}`, read_tier: 'model_readable', text: '原文', readable: true } } },
        { why: 'bytes for functions only', value: { ...ok, content: { reference: `src:${H}`, read_tier: 'function_bytes_only', sha256: H, structure: { sheets: 2 }, readable: false } } },
        { why: 'neutral answer', value: failed() },
      ],
      invalid: [
        { why: 'node reference is not root + path', value: { ...ok, root: H, nodes: [{ ...node, reference: `tree:${H2}/commands/show` }] }, refinement: true },
        { why: 'entry reference not pinned to the entry', value: { ...ok, root: H, nodes: [{ ...node, entries: [{ ...node.entries[0], reference: `tree:${H}/commands/show` }] }] }, refinement: true },
        { why: 'nodes without their root', value: { ...ok, nodes: [node] }, refinement: true },
        { why: 'an error with nodes', value: { ...failed(), root: H, nodes: [node] }, refinement: true },
        { why: 'text of bytes for functions only', value: { ...ok, content: { reference: `src:${H}`, read_tier: 'function_bytes_only', text: '原文', readable: false } }, refinement: true },
        { why: 'node path not canonical', value: { ...ok, root: H, nodes: [{ ...node, path: '/commands/show item' }] } },
        { why: 'entry reference that is a bare entry', value: { ...ok, root: H, nodes: [{ ...node, entries: [{ ...node.entries[0], reference: `entry:${H3}` }] }] } },
      ],
    },
  },
  resolve_reference: {
    input: {
      valid: [{ why: 'a command', value: { run: RUN, text: 'show item', expect: 'command' } }],
      invalid: [
        { why: 'malformed run id', value: { run: 'run_123', text: 'x' } },
        { why: 'empty text', value: { run: RUN, text: '' } },
        { why: 'misspelled key', value: { run: RUN, text: 'x', expected: 'command' } },
      ],
    },
    output: {
      valid: [
        { why: 'resolved', value: { ...ok, resolution: 'resolved', references: [{ reference: `tree:${H}/commands/show@${H3}`, text: 'show item', role: 'expected' }], diagnostics: [] } },
        { why: 'unresolved with near candidates', value: { ...ok, resolution: 'unresolved', references: [{ reference: `tree:${H}/commands/shown`, text: 'shown' }], diagnostics: ['没有 show items'] } },
        { why: 'neutral answer: the same empty shape', value: { ...failed(), references: [], diagnostics: [] } },
      ],
      invalid: [
        { why: 'ok without a resolution', value: { ...ok, references: [], diagnostics: [] }, refinement: true },
        { why: 'an error with a resolution', value: { ...failed(), resolution: 'unresolved', references: [], diagnostics: [] }, refinement: true },
        { why: 'an error with referents', value: { ...failed(), references: [{ reference: `src:${H}`, text: 'x' }], diagnostics: [] }, refinement: true },
        { why: 'a referent that cannot be a ground', value: { ...ok, resolution: 'resolved', references: [{ reference: `entry:${H3}`, text: 'x' }], diagnostics: [] } },
      ],
    },
  },
  submit_result: {
    input: {
      valid: [{ why: 'the synthetic submission', value: submission }],
      invalid: [
        { why: 'misspelled keys', value: { run: RUN, model: 'm', items: [{ item: 'doc:n1', handling: 'handled', slot: {} }], cross_items: [] } },
        { why: 'skipped without a reason', value: { ...submission, items: [{ item: 'a', handling: 'skipped' }] } },
        { why: 'fact without grounds', value: { ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [] }] } },
        { why: 'entry as a ground', value: { ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [`entry:${H}`] }] } },
        { why: 'malformed run id', value: { ...submission, run: 'run_123' } },
        { why: 'an item declared twice', value: { ...submission, items: [submission.items[0], submission.items[0]] }, refinement: true },
        { why: 'a premise on a later entry', value: { ...submission, cross_item: [{ nature: 'judgment', statement: 's', grounds: [], premises: ['/cross_item/1'] }, submission.cross_item[0]] }, refinement: true },
        { why: 'slots and reuse', value: { ...submission, items: [{ item: 'a', handling: 'handled', slots: {}, reuse: `rec:${H}` }] }, refinement: true },
        { why: 'reversed byte range in a ground', value: { ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [`src:${H}/p@1/x:9-1`] }] }, refinement: true },
        { why: 'astral format character in a ground', value: { ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [`tree:${H}/a\u{E0001}`] }] }, refinement: true },
      ],
    },
    output: {
      valid: [
        { why: 'accepted', value: { ...ok, trace: TRACE2, acceptance: 'accepted', result: accepted, counts: acceptedCounts() } },
        { why: 'not accepted, validated against the run', value: { ...failed(notAccepted.errors[0]), acceptance: 'not_accepted', result: notAccepted } },
        { why: 'neutral answer for an absent or unavailable run (D05 R[3])', value: { ...failed(), acceptance: 'not_accepted' } },
        { why: 'malformed run id: no run, no result (T03 R[3])', value: { ...failed(malformedRun), acceptance: 'not_accepted' } },
      ],
      invalid: [
        { why: 'accepted without counts', value: { ...ok, acceptance: 'accepted', result: accepted }, refinement: true },
        { why: 'accepted without a result', value: { ...ok, acceptance: 'accepted', counts: acceptedCounts() }, refinement: true },
        { why: 'counts not derived from the partitions', value: { ...ok, acceptance: 'accepted', result: accepted, counts: { ...acceptedCounts(), delivered: 3 } }, refinement: true },
        { why: 'counts on a submission that is not accepted', value: { ...failed(), acceptance: 'not_accepted', result: notAccepted, counts: acceptedCounts() }, refinement: true },
        { why: 'receipt and result disagree', value: { ...failed(), acceptance: 'not_accepted', result: accepted }, refinement: true },
        {
          why: 'one item in two partitions',
          value: { ...ok, acceptance: 'accepted', result: { ...accepted, partitions: { ...accepted.partitions, rejected: [{ ...(accepted.partitions.delivered[0] as object), code: 'x' }] } }, counts: acceptedCounts() },
          refinement: true,
        },
        { why: 'result with an unknown key', value: { ...ok, acceptance: 'accepted', result: { ...accepted, items: [] }, counts: acceptedCounts() } },
        { why: 'result bound to a malformed run id', value: { ...failed(malformedRun), acceptance: 'not_accepted', result: { ...notAccepted, run: 'run_123' } } },
        { why: 'receipt missing', value: failed() },
      ],
    },
  },
};

const validators = new Map(
  published.map((t) => [t.name, { input: ajv.getValidator(t.inputSchema), output: ajv.getValidator(t.outputSchema) }]),
);

describe('tool shapes: zod and the published schema agree', () => {
  test('every tool has cases for both directions', () => {
    assert.deepEqual(Object.keys(CASES), TOOLS.map((t) => t.name));
  });
  for (const tool of TOOLS) {
    for (const side of ['input', 'output'] as const) {
      const schema: z.ZodType = tool[side];
      const client = validators.get(tool.name)?.[side];
      assert.ok(client, `${tool.name} is published`);
      test(`${tool.name} ${side}: valid cases pass zod and the published schema`, () => {
        for (const c of CASES[tool.name][side].valid) {
          const parsed = schema.safeParse(copy(c.value));
          assert.ok(parsed.success, `${c.why}: ${parsed.error?.message}`);
          assert.deepEqual(parsed.data, c.value, `${c.why}: parsing changes nothing`);
          const checked = client(copy(c.value));
          assert.ok(checked.valid, `${c.why}: ${checked.errorMessage}`);
        }
      });
      test(`${tool.name} ${side}: invalid cases are refused; refinement-only cases are named`, () => {
        for (const c of CASES[tool.name][side].invalid) {
          assert.equal(schema.safeParse(copy(c.value)).success, false, `zod refuses: ${c.why}`);
          assert.equal(client(copy(c.value)).valid, c.refinement === true, c.refinement ? `only zod can refuse: ${c.why}` : `the published schema refuses: ${c.why}`);
        }
      });
    }
  }
  test('a protocol error never needs invented run, lock or digest values (D05 R[3], T03 R[3])', () => {
    const submit = TOOLS.find((t) => t.name === 'submit_result');
    const neutral = { ...failed(), acceptance: 'not_accepted' };
    assert.equal(submit?.output.safeParse(neutral).success, true);
    assert.equal(validators.get('submit_result')?.output(neutral).valid, true);
    const resolve = TOOLS.find((t) => t.name === 'resolve_reference');
    assert.equal(resolve?.output.safeParse({ ...failed(), references: [], diagnostics: [] }).success, true);
  });
  test('megabyte inputs give issues, never a thrown stack overflow', () => {
    const upload = TOOLS.find((t) => t.name === 'upload_file');
    const submit = TOOLS.find((t) => t.name === 'submit_result');
    const atCap = 'A'.repeat(MAX_UPLOAD_BASE64_LENGTH);
    assert.equal(upload?.input.safeParse({ file_path: atCap }).success, true, 'a payload at the cap is checked without overflow');
    assert.equal(upload?.input.safeParse({ file_path: `${atCap}AAAA` }).success, false);
    const huge = `tree:${H}/${'b'.repeat(20_000_000)}`;
    assert.equal(submit?.input.safeParse({ ...submission, cross_item: [{ nature: 'fact', statement: 's', grounds: [huge] }] }).success, false);
    const item = { item: 'a', handling: 'handled', reuse: `rec:${H}#/${'c'.repeat(20_000_000)}` };
    assert.equal(submit?.input.safeParse({ ...submission, items: [item] }).success, false);
  });
  test('an empty manifest is accepted with zero counts', () => {
    const empty = { ...accepted, partitions: partitions({}), cross_item: [] };
    const counts = Object.fromEntries([...PARTITION, 'unknown'].map((key) => [key, 0]));
    const submit = TOOLS.find((t) => t.name === 'submit_result');
    assert.equal(submit?.output.safeParse({ ...ok, acceptance: 'accepted', result: empty, counts }).success, true);
  });
});
