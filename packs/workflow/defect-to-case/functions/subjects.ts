// Subject builders for defect-to-case checks.
import type { DraftCase, DraftExpected, DraftStep } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractDrafts(slots: unknown): DraftCase[] {
  if (!isRecord(slots) || !Array.isArray(slots.cases)) return [];
  const drafts: DraftCase[] = [];
  for (const item of slots.cases) {
    if (!isRecord(item)) continue;
    // Data may be in claim.data or directly on item
    const raw = isRecord(item.data) ? item.data : item;
    const title = typeof raw.title === 'string' ? raw.title : (typeof item.text === 'string' ? item.text : '');
    const priority = typeof raw.priority === 'number' ? raw.priority : 2;
    const negative = raw.negative === true;
    const expects_refutation = raw.expects_refutation === true;
    const preconditions = Array.isArray(raw.preconditions) ? raw.preconditions.filter((p): p is string => typeof p === 'string') : [];
    const steps: DraftStep[] = [];
    if (Array.isArray(raw.steps)) {
      for (const s of raw.steps) {
        if (isRecord(s) && typeof s.command === 'string') {
          steps.push({ command: s.command, ...(typeof s.note === 'string' ? { note: s.note } : {}) });
        }
      }
    }
    const expected: DraftExpected[] = [];
    if (Array.isArray(raw.expected)) {
      for (const e of raw.expected) {
        if (!isRecord(e) || typeof e.text !== 'string') continue;
        const q = isRecord(e.quote) && typeof e.quote.reference === 'string' && typeof e.quote.text === 'string'
          ? { reference: e.quote.reference, text: e.quote.text }
          : undefined;
        if (q) expected.push({ text: e.text, quote: q });
        else expected.push({ text: e.text, quote: { reference: '', text: '' } });
      }
    }
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [];
    drafts.push({
      title,
      priority,
      negative,
      expects_refutation,
      preconditions,
      steps,
      expected,
      tags,
    });
  }
  return drafts;
}

function extractItemId(record: Record<string, unknown>): string {
  if (typeof record.item === 'string') return record.item;
  if (isRecord(record.item) && typeof record.item.id === 'string') return record.item.id;
  return '';
}

function extractLocation(record: Record<string, unknown>): string | null {
  if (typeof record.location === 'string') return record.location;
  if (isRecord(record.item) && typeof record.item.location === 'string') return record.item.location;
  return null;
}

export function commandSubject(input: unknown): unknown {
  const record = isRecord(input) ? input : {};
  const itemId = extractItemId(record);
  const location = extractLocation(record);
  const drafts = extractDrafts(record.slots);

  // Command lines for catalog@1: check drafts whose commands are expected to be valid in catalog
  const phrases: string[] = [];
  for (const draft of drafts) {
    if (draft.expects_refutation !== true) {
      for (const step of draft.steps) {
        if (step.command.trim()) phrases.push(step.command.trim());
      }
    }
  }

  return {
    item: itemId,
    location,
    phrases,
    negative: false,
  };
}

export function quoteSubject(input: unknown): unknown {
  const record = isRecord(input) ? input : {};
  const itemId = extractItemId(record);
  const slots = isRecord(record.slots) ? record.slots : {};
  const quotes: Array<{ reference: string; text: string; case: number; expected: number }> = [];
  for (const [caseIndex, claim] of (Array.isArray(slots.cases) ? slots.cases : []).entries()) {
    if (!isRecord(claim)) continue;
    const data = isRecord(claim.data) ? claim.data : claim;
    for (const [expectedIndex, exp] of (Array.isArray(data.expected) ? data.expected : []).entries()) {
      if (!isRecord(exp) || !isRecord(exp.quote) || typeof exp.quote.reference !== 'string' || typeof exp.quote.text !== 'string' || !exp.quote.reference || !exp.quote.text) continue;
      quotes.push({ reference: exp.quote.reference, text: exp.quote.text, case: caseIndex, expected: expectedIndex });
    }
  }

  return {
    item: itemId,
    quotes,
    allowed_quote_sources: isRecord(record.item) && isRecord(record.item.fields) ? record.item.fields.allowed_quote_sources : undefined,
  };
}

export function duplicateSubject(input: unknown): unknown {
  const record = isRecord(input) ? input : {};
  const itemId = extractItemId(record);
  const drafts = extractDrafts(record.slots);

  const context = isRecord(record.context) ? record.context : {};
  let indexedCases: unknown = null;
  if (Array.isArray(context.groups)) {
    for (const g of context.groups) {
      if (isRecord(g) && g.indexed_cases) {
        indexedCases = g.indexed_cases;
        break;
      }
    }
  }

  return {
    item: itemId,
    drafts,
    indexed_cases: indexedCases,
  };
}

export default function (input: unknown): unknown {
  return commandSubject(input);
}
