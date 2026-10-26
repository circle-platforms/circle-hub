// Deployment vocabularies are synthetic and supplied as producer options, never shipped product values.
//
// Applicability is read only from the declared structure (famx-applicability@1, carried as applicability-state@1) and from
// verified claims with their quotes; reading conditions out of prose phrases was retired, so a closed vocabulary passed
// as a producer option licenses no phrase extraction any more. A sentence that names a vocabulary member is still just a
// sentence: the entry stays `undeclared` / `unjudged` and the run counts what it declared and inherited per field. The
// declared paths themselves are covered by applicability-claims, applicability-report and applicability-variables.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown } from '../testing/test-support.ts';
import { produceManualEntries } from './manual.ts';
import type { ManualOptions } from './types.ts';
import { manual as producer } from './producers.ts';

const closed = { components: ['Card-A', 'Card-B'], licenses: ['Permit-A', 'Permit-B'], deployment_forms: ['Form-A', 'Form-B'] };

function produced(text: string, options: ManualOptions = closed) {
  const out = produceManualEntries(markdown('# Synthetic chapter\n\n' + text + '\n'), null, options);
  const found = out.entries.find((row) => row.statement === text);
  assert.ok(found, JSON.stringify(out).slice(0, 300));
  return { entry: found, out };
}

type State = { schema: string; grammar: string; declaration_status: string; judgment_status: string; declared_fields: unknown[]; conflicted_fields: unknown[]; criteria_digest: string };
const stateOf = (entry: { data: Record<string, unknown> }): State => entry.data.applicability_state as State;

// Every sentence the retired reader used to turn into a condition: component presence and absence, a license, deployment
// forms, memory bounds in each relation, unit and fraction, plus the negations, exceptions, vague forms, unsupported
// units and unsafe numbers that already stayed in the source. None of them is a declaration.
const PROSE = [
  '装有 Card-A、Card-B 时。', '装有 Card-A 部件时。', '没有 Card-B 时。', '需要 Permit-A 许可。', '适用于 Form-A、Form-B。', '仅 Form-A 支持。',
  '装有 Card-A、Unknown 时。', '需要 Permit-A、Unknown 许可。', '适用于 Form-A、Unknown。', '不需要 Permit-A 许可。', '适用于 Form-A 以外。', '可能适用于 Form-A。', '仅 Form-A 支持，但 Form-B 除外。',
  '内存不少于 8 GB。', '内存至少 8G。', '内存大于 8GB。', '内存小于 8GB。', '内存不超过 8GB。', '内存 8GB 以上。', '内存 8GB 以下。',
  '内存至少 2GB。', '内存至少 2G。', '内存至少 2MB。', '内存至少 2M。', '16 G 内存的设备。', '内存至少1.5GB。', '内存至少0.1GB。',
  '内存较大时。', '不适用于16G内存的设备。', '内存至少8GB以外。', '约16G内存的设备。', '内存至少8TB。', '内存至少999999999999999999GB。', '内存大于8GB或内存小于4GB。',
  '没有 Card-B 时，内存不超过8GB。',
] as const;

test('prose declares no applicability: every retired phrase stays undeclared and unjudged', () => {
  for (const text of PROSE) {
    const { entry } = produced(text);
    assert.equal(entry.applicability, null, text);
    const state = stateOf(entry as { data: Record<string, unknown> });
    assert.equal(state.schema, 'applicability-state@1', text);
    assert.equal(state.grammar, 'famx-applicability@1', text);
    assert.equal(state.declaration_status, 'undeclared', text);
    assert.equal(state.judgment_status, 'unjudged', text);
    assert.deepEqual(state.declared_fields, [], text);
    assert.deepEqual(state.conflicted_fields, [], text);
    assert.equal(typeof state.criteria_digest, 'string', text);
    assert.equal(state.criteria_digest.length, 64, text);
  }
});

test('a closed vocabulary in the options licenses no phrase reading, and an empty vocabulary changes nothing', () => {
  assert.equal(produced('需要 Permit-A 许可。').entry.applicability, null);
  assert.equal(produced('装有 Card-A 时。', { components: [], licenses: [], deployment_forms: [] }).entry.applicability, null);
  assert.equal(stateOf(produced('装有 Card-A 时。', { components: [], licenses: [], deployment_forms: [] }).entry as { data: Record<string, unknown> }).declaration_status, 'undeclared');
});

test('the product producer forwards the resolved closed vocabularies and still declares nothing from prose', () => {
  const text = '需要 Permit-A 许可。';
  const out = producer({ slots: { cli: { parser: 'markdown@1', model: markdown('# Synthetic\n\n' + text + '\n') } }, params: closed });
  const found = out.entries.find((row) => row.statement === text);
  assert.ok(found, JSON.stringify(out).slice(0, 300));
  assert.equal(found.applicability, null);
  assert.equal(stateOf(found as unknown as { data: Record<string, unknown> }).declaration_status, 'undeclared');
});

test('the run counts declarations and inheritances per field, so a missing declaration is visible', () => {
  const { out } = produced('没有 Card-B 时，内存不超过8GB。');
  for (const field of ['型号', '平台', '起止构建', '部件', '内存', '许可']) {
    assert.ok(
      out.warnings.some((warning) => warning.startsWith(`适用条件统计：${field}：`) && /结构声明 0 条，继承 0 条/.test(warning)),
      `${field}: ${JSON.stringify(out.warnings)}`,
    );
  }
});
