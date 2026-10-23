// Public surface and local packaging commands of the SVN system pack.
import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../workflow/case-review/packaging.ts';
export const PACK_ID = 'svn';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));
export * from './functions/webdav.ts';
if (import.meta.main) process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
