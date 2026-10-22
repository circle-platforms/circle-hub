// Public surface of the Lumen API product pack for other packages and tooling: where the pack lives, its id, the packaging
// commands, and the pure functions. The published pack is exactly the files pack.json lists (product.json, functions/).
//
//   node packs/product/lumen-api/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';

export const PACK_ID = 'lumen-api';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export { planBuilds, RELEASES, FAMILY } from './functions/sync.ts';
export { selectBuild } from './functions/select.ts';
export { produceEndpoints, paramOf, endpointPath } from './functions/endpoints.ts';

/** The functions product.json declares, as the sandbox calls them. */
export const FUNCTIONS = {
  syncPlan: { module: 'functions/sync.ts', export: 'default' },
  selectBuildRule: { module: 'functions/select.ts', export: 'default' },
  endpointsProducer: { module: 'functions/endpoints.ts', export: 'default' },
} as const;

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
