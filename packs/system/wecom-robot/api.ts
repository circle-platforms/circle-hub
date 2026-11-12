// Public surface of the wecom-robot system pack for other packages and tooling: the read-only WeCom robot profile
// (address-book members and appchat groups) and its pure projection functions, run in the Hub sandbox by the
// connectors. Sending is deliberately absent: an outbound message is an executor@1 write made at deployment, so no
// profile route can reach it. The published pack is system.json and functions/.
//
//   node packs/system/wecom-robot/api.ts check | sign | stage <directory>
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';

export const PACK_ID = 'wecom-robot';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export * from './functions/wecom.ts';

if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
