// Public surface of the agile-platform system pack for other packages and tooling: the agile test platform (mind maps, folder trees, the search for similar test lists). Where the pack lives, its packaging and
// its read functions (pure, run in the Hub sandbox by the connectors). The published pack is system.json and functions/.
//
//   node packs/system/agile-platform/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';

export const PACK_ID = 'agile-platform';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export * from './functions/agile.ts';

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
