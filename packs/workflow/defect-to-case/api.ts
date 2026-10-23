// Public surface of the defect-to-case workflow pack for other packages and tooling.
import { fileURLToPath } from 'node:url';
import { manifestProblems, readManifest, signManifest, stage } from './pack-files.ts';

export const PACK_ID = 'defect-to-case';
/** Absolute path of the pack's source directory, with a trailing separator. */
export const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));

export { projectDefects as projection, projectDefects, DEFECTS_SLOT, INDEXED_CASES_SLOT, MAX_DEFECTS } from './functions/projection.ts';
export { expectedSources } from './functions/expected.ts';
export { extractDrafts, commandSubject, quoteSubject, duplicateSubject } from './functions/subjects.ts';
export {
  checkDraftShape,
  checkCommandsRefutation,
  checkGroundedReading,
  checkQuoteSources,
  checkDuplicate,
  normalizeTag,
} from './functions/checks.ts';
export { CODES, CANONICAL_CATEGORIES } from './functions/types.ts';

/** The functions declared in workflow.json and checks.json */
export const FUNCTIONS = {
  projection: { module: 'functions/projection.ts', export: 'default' },
  expected: { module: 'functions/expected.ts', export: 'default' },
  commandSubject: { module: 'functions/subjects.ts', export: 'commandSubject' },
  quoteSubject: { module: 'functions/subjects.ts', export: 'quoteSubject' },
  duplicateSubject: { module: 'functions/subjects.ts', export: 'duplicateSubject' },
  checkDraftShape: { module: 'functions/checks.ts', export: 'checkDraftShape' },
  checkCommandsRefutation: { module: 'functions/checks.ts', export: 'checkCommandsRefutation' },
  checkGroundedReading: { module: 'functions/checks.ts', export: 'checkGroundedReading' },
  checkQuoteSources: { module: 'functions/checks.ts', export: 'checkQuoteSources' },
  checkDuplicate: { module: 'functions/checks.ts', export: 'checkDuplicate' },
} as const;

async function cli(args: string[]): Promise<number> {
  const command = args[0] ?? 'check';
  if (command === 'check') {
    const problems = await manifestProblems();
    if (problems.length === 0) {
      console.log('pack.json is current');
      return 0;
    }
    console.error('pack.json differs from disk files:\n' + problems.join('\n'));
    return 1;
  }
  if (command === 'sign') {
    await signManifest();
    console.log('signed pack.json');
    return 0;
  }
  if (command === 'stage') {
    const target = args[1];
    if (!target) {
      console.error('Usage: api.ts stage <directory>');
      return 1;
    }
    await stage(target);
    console.log(`staged to ${target}`);
    return 0;
  }
  console.error(`Unknown command: ${command}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await cli(process.argv.slice(2));
}
