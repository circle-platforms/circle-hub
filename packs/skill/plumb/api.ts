import { fileURLToPath } from 'node:url';

export const PACK_ID = 'plumb';
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export * from './functions/modules/plumb-client/index.ts';

if (import.meta.main) {
  const { packagingCli } = await import('../../workflow/case-review/packaging.ts');
  process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
}
