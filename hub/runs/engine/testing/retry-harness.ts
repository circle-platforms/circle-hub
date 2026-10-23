// Reuse the toy domain with a synthetic modern version line for retry regressions.
import type { TemporaryPostgres } from '../../../testing/postgres.ts';
import { openHarness, type HarnessOptions } from './harness.ts';

export async function openRetryHarness(postgres: TemporaryPostgres, options: HarnessOptions = {}) {
  const h = await openHarness(postgres, options);
  const original = (await h.knowledge.builds('meadow')).find(build => build.root !== null && build.name === build.base)!;
  const oldInfo = (await h.knowledge.rootOfBuild('meadow', original.name))!;
  const build = { ...original, name: 'Rel_MEADOW_10_6_1_7', base: 'Rel_MEADOW_10_6_1_7', line: '10.6.1' };
  const info = { ...oldInfo, build };
  h.knowledge.builds = async () => [build];
  h.knowledge.resolveBuild = async (_product, name) => name === build.name ? build : null;
  h.knowledge.currentRoot = async (product, line) => product === 'meadow' && line === build.line ? info : null;
  h.knowledge.rootOfBuild = async (_product, name) => name === build.name ? info : null;
  h.knowledge.rootInfo = async root => root === info.root ? [info] : [];
  return h;
}
