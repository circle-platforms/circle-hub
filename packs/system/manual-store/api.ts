// Public surface of the manual-store system pack for other packages and tooling: the anonymous document store (manuals, specs, the spec search). Where the pack lives, its packaging and
// its read functions (pure, run in the Hub sandbox by the connectors). The published pack is system.json and functions/.
//
//   node packs/system/manual-store/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';

export const PACK_ID = 'manual-store';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export * from './functions/webdav.ts';

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
