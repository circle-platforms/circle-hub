// Public surface of the plm system pack for other packages and tooling: the PLM query service (bugs, stories, products, builds; reads only). Where the pack lives, its packaging and
// its read functions (pure, run in the Hub sandbox by the connectors). The published pack is system.json and functions/.
//
//   node packs/system/plm/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';

export const PACK_ID = 'plm';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export * from './functions/plm.ts';

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
