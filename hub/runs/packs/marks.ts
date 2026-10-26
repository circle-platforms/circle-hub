// The qualifier marks the publish check gives the checks of a workflow version (T02 R[1]), by where their samples come from.
// The publish check stores them in its report; LoadedWorkflow (hub/ports.ts) has no field for them yet (README, "Needs from
// other packages"), so publishCheckMarks derives them for a run from the sample files of the version through its readJson,
// with the same rule. Imports contracts only (and the port's type), so the run engine can use it without the registry.
import type { QualifierMark } from '../../../contracts/generated/vocabulary.ts';
import { PackSample, SAMPLE_SOURCES } from '../../../contracts/src/pack.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import type { SampleSource } from './types.ts';

const AUTHOR_ONLY: QualifierMark = 'author_samples_only';

const noSamples = (): Record<SampleSource, number> => Object.fromEntries(SAMPLE_SOURCES.map((s) => [s, 0])) as Record<SampleSource, number>;

/** The marks of a check by its sample counts per source: author_samples_only when none comes from outside the author. */
export function sampleMarks(sources: Readonly<Record<SampleSource, number>>): QualifierMark[] {
  return SAMPLE_SOURCES.every((source) => source === 'author' || sources[source] === 0) ? [AUTHOR_ONLY] : [];
}

/** Check id to its marks, from the samples the version carries (none at all is author-only too). */
export function publishCheckMarks(workflow: Pick<LoadedWorkflow, 'manifest' | 'checks' | 'readJson'>): Record<string, QualifierMark[]> {
  const sources = new Map<string, Record<SampleSource, number>>();
  for (const file of workflow.manifest.files) {
    if (!file.path.startsWith('samples/') || !file.path.endsWith('.json')) continue;
    const parsed = PackSample.safeParse(workflow.readJson(file.path));
    if (!parsed.success) continue;
    const counts = sources.get(parsed.data.check) ?? noSamples();
    counts[parsed.data.source] += 1;
    sources.set(parsed.data.check, counts);
  }
  return Object.fromEntries(workflow.checks.map((check) => [check.id, sampleMarks(sources.get(check.id) ?? noSamples())]));
}
