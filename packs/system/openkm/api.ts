// Public surface of the openkm system pack for other packages and tooling: the document library behind Basic authentication (same reads as the document store). Where the pack lives, its packaging and
// its read functions (pure, run in the Hub sandbox by the connectors). The published pack is system.json and functions/.
//
//   node packs/system/openkm/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';

export const PACK_ID = 'openkm';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export * from './functions/webdav.ts';

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
