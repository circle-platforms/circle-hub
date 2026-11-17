// Public packaging and type entrypoint for the plumb skill pack (excluded from pack.json manifest).
import { fileURLToPath } from 'node:url';

export const PACK_ID = 'plumb';
/** Absolute path of the pack's source directory, with a trailing separator. */
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export * from './functions/modules/plumb-client/index.ts';

if (import.meta.main) {
  const { packagingCli } = await import('../../workflow/case-review/packaging.ts');
  process.exitCode = await packagingCli({ [PACK_ID]: PACK_DIR }, process.argv.slice(2));
}
