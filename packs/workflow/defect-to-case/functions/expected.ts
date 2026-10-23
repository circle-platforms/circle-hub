// The caller binds the version-line manual explicitly before projection so its source identity can be frozen.
import type { ExpectedSourcesOutput } from '../../../../contracts/src/pack.ts';
export function expectedSources(_input: unknown): ExpectedSourcesOutput {
  return { sources: [], warnings: [] };
}
export default expectedSources;
