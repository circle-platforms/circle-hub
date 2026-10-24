// Mechanical quotation verification only. The caller must first resolve a source reference against the bound original
// and pass its pre-order node index. A successful check says nothing about the semantic category of that quotation.
import type { DocumentCases } from './cases.ts';

type EvidenceDocument = Pick<DocumentCases, 'cases' | 'nodes'>;

/** Build once per parsed document; case boundaries are those of casesOf, never inferred from the text of a node. */
export function caseEvidenceVerifier(document: EvidenceDocument): (caseId: string, node: number, quote: string) => boolean {
  const { texts, parents } = document.nodes;
  const cases = new Map(document.cases.map(record => [record.visit, record.id]));
  const owners: Array<string | null> = [];
  // casesOf produces a pre-order tree: each parent is -1 or an earlier index. Fail closed on an invalid parent table.
  if (parents.length !== texts.length) return () => false;
  for (let node = 0; node < texts.length; node++) {
    const parent = parents[node];
    if (!Number.isInteger(parent) || parent < -1 || parent >= node || (node > 0 && parent === -1)) return () => false;
    owners.push(cases.get(node) ?? (parent === -1 ? null : owners[parent]));
  }
  return (caseId, node, quote) => Number.isSafeInteger(node) && node >= 0 && node < texts.length
    && owners[node] === caseId && quote.length > 0 && texts[node].includes(quote);
}

/** Convenience for a single already-resolved quotation; batches should reuse caseEvidenceVerifier. */
export function caseQuoteMatches(document: EvidenceDocument, caseId: string, node: number, quote: string): boolean {
  return caseEvidenceVerifier(document)(caseId, node, quote);
}
