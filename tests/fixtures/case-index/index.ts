// Entry point of the case-index fixtures (invented content, structure of the real agile platform and build site): the
// command truth table, the command catalogs of two builds, and the corpus of an agile platform with 300 test mind maps
// and their truth. Options for hub/connectors/testing startAgileStub, and the answers of the tree read's routes for tests
// of a planner or projection without a stub.
import { caseCorpus, type Corpus } from './corpus.ts';

export { CASE_COMMAND_TABLE, tableRow, type TableRow } from './table.ts';
export { CATALOG_A, CATALOG_B, CHANGED_COMMANDS, commandPath, commandTreeXml, type Arg, type Command } from './catalog.ts';
export {
  DEFAULT_NAMES,
  MIN_LINE,
  VAGUE_TEXTS,
  caseCorpus,
  compareLine,
  documentBytes,
  lineForm,
  listedFor,
  type AgileNode,
  type CaseTruth,
  type Corpus,
  type DocumentTruth,
  type KmDocument,
  type KmNode,
} from './corpus.ts';

export const CASE_INDEX_ACCOUNT = { username: 'case-reader', password: 'Synthetic#Cases42' };

/** Options for startAgileStub: the listing, the trees of the configured roots and every document. */
export function caseIndexAgileOptions(corpus: Corpus = caseCorpus()): {
  username: string;
  password: string;
  roots: { id: string; label: string }[];
  trees: Corpus['trees'];
  documents: Record<string, unknown>;
  expiredCode: number;
} {
  return { ...CASE_INDEX_ACCOUNT, roots: corpus.listing, trees: corpus.trees, documents: corpus.documents, expiredCode: 401 };
}

/**
 * One page of the root listing as the platform answers it: ten roots in `data`, the total a sibling of `data`
 * (pages past the end repeat page 1).
 */
export function listingAnswer(corpus: Corpus, page: number): { code: number; msg: string; data: { id: string; label: string }[]; total: number } {
  const pages = Math.max(1, Math.ceil(corpus.listing.length / 10));
  const shown = Number.isInteger(page) && page >= 1 && page <= pages ? page : 1;
  return { code: 1000, msg: '', data: corpus.listing.slice((shown - 1) * 10, shown * 10), total: corpus.listing.length };
}

/** The subtree answer of a root, or the platform's answer for a root it does not have. */
export function subtreeAnswer(corpus: Corpus, root: string): { code: number; msg: string; data: unknown } {
  const tree = corpus.trees[root];
  return tree === undefined ? { code: 1004, msg: '节点不存在', data: null } : { code: 1000, msg: '', data: tree };
}
