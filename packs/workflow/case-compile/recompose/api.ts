import { fileURLToPath } from 'node:url';
import { packagingCli } from '../../case-review/packaging.ts';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));
if (import.meta.main)
    process.exitCode = await packagingCli({ 'recompose': PACK_DIR }, process.argv.slice(2));
