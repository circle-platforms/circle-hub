// The expected sources of a review (workflow@1 expected_sources, ExpectedSourcesInput -> ExpectedSourcesOutput), by
// expectedSources (expected-sources.ts): the title and the folders above the document come from the subject's meta (what the
// agile system pack derived), else the mind-map root; the product's names (context.names) are left out of search terms.
// - expected: the PLM stories and bugs named in the title, the folders or the parameters (evidence group a), and the spec
//   search for the feature words of the title (group b; the store reads the best five spec files);
// - hint: the test strategy documents for the same feature words (group d, `manual:qa-search`) and similar test lists on the
//   agile platform (group e, `agile:search`, leaving out the reviewed document itself, which matches its own title's terms):
//   they may shape the coverage a reviewer expects, never ground a statement about product behaviour.
// The CLI manual and the command catalog of the build (group c) are in the run's locked knowledge root, not bound here.
import type { BoundInput, ExpectedSource, ExpectedSourcesOutput } from '../../../../contracts/src/pack.ts';
import { failure, guarded, isRecord, withWorkflowNames } from './common.ts';
import { expectedSources, featureTerms, specSearchId } from './expected-sources.ts';
import { SUBJECT_SLOT, documentIdOf } from './projection.ts';
import type { PackError, Warning } from './types.ts';

const SPEC_SEARCH = 'manual:spec-search:';
export const HISTORY_SEARCH = 'agile:search:';
export const STRATEGY_SEARCH = 'manual:qa-search:';
const DEFAULT_TERMS = 8;
/** Run parameters (workflow.json names) of the expected sources, and the names expected-sources.ts reads them under. */
export const SOURCE_PARAMETERS = {
  stories: 'stories',
  bugs: 'bugs',
  id_ranges: 'idRanges',
  bare_ids: 'bareIds',
  spec_search: 'specSearch',
  max_terms: 'maxTerms',
  history_search: 'historySearch',
  strategy_search: 'strategySearch',
} as const;
/** An agile document id the history search can leave out (the agile system pack's id form). */
const AGILE_ID = /^[0-9A-Za-z_-]{1,64}$/;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []);

/** The agile document id of the subject, when it was read from the agile platform. */
function agileDocument(subject: BoundInput): string | null {
  const id = typeof subject.external === 'string' ? /^agile:mindmap:([^@]+)/.exec(subject.external)?.[1] : undefined;
  return id !== undefined && AGILE_ID.test(id) ? id : null;
}

export function expected(input: unknown): ExpectedSourcesOutput {
  if (!isRecord(input) || !Array.isArray(input.inputs)) return failure('invalid_input', '输入里没有 inputs 数组', '按 expected-sources-input@1 传入');
  const subject = (input.inputs as unknown[]).find((i): i is BoundInput => isRecord(i) && i.slot === SUBJECT_SLOT) as BoundInput | undefined;
  if (subject === undefined) return { sources: [], warnings: [] };
  const meta = isRecord(subject.meta) ? subject.meta : {};
  const context = isRecord(input.context) ? input.context : {};
  const names = strings(context.names);
  const given = isRecord(input.parameters) ? input.parameters : {};
  const parameters: Record<string, unknown> = {};
  for (const [name, inner] of Object.entries(SOURCE_PARAMETERS)) if (Object.hasOwn(given, name)) parameters[inner] = given[name];
  const title = typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : undefined;
  // The agile system pack writes `ancestors` (root first); `folders` is the same list under the name other readers use.
  const ancestors = strings(meta.ancestors ?? meta.folders);
  const documentId = documentIdOf(subject);
  const found = expectedSources({ documents: [{ slot: SUBJECT_SLOT, documentId, model: subject.model as never, title, ancestors }], product: { names }, parameters });
  if ('error' in found) return { error: found.error, warnings: found.warnings };
  const sources: ExpectedSource[] = found.basis.map((basis) => ({ external: basis.external, role: 'expected', reason: basis.reason }));
  if (parameters.historySearch !== false || parameters.strategySearch !== false) {
    const root = isRecord(subject.model) && Array.isArray(subject.model.nodes) && isRecord(subject.model.nodes[0]) ? subject.model.nodes[0].text : null;
    const text = title ?? (typeof root === 'string' ? root : '');
    const max = typeof parameters.maxTerms === 'number' && Number.isInteger(parameters.maxTerms) && parameters.maxTerms >= 1 && parameters.maxTerms <= 16 ? parameters.maxTerms : DEFAULT_TERMS;
    const id = specSearchId(featureTerms(text, names, max));
    const terms = id !== null && id.startsWith(SPEC_SEARCH) ? id.slice(SPEC_SEARCH.length) : null;
    if (terms !== null && parameters.strategySearch !== false) {
      sources.push({ external: `${STRATEGY_SEARCH}${terms}`, role: 'hint', reason: '标题里的功能词，用来找同类功能的测试策略文档（线索：可以帮助判断该用哪些维度和方法，不作产品行为的根据）' });
    }
    if (terms !== null && parameters.historySearch !== false) {
      const own = agileDocument(subject);
      sources.push({
        external: `${HISTORY_SEARCH}${terms}${own !== null ? `+!${own}` : ''}`,
        role: 'hint',
        reason: `标题里的功能词，用来找相似功能的历史测试清单（线索：可以帮助判断该覆盖什么，不作产品行为的根据）${own !== null ? '；被评审的这份文档本身不算' : ''}`,
      });
    }
  }
  return { sources, warnings: found.warnings };
}

export default function (input: unknown): unknown {
  return guarded(() => withWorkflowNames(expected(input) as { warnings: Warning[]; error?: PackError }));
}
