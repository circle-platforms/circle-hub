// Type definitions and constants for defect-to-case workflow pack.
import {TEST_TYPE_IDS} from './generated/vocabulary.ts';
import type {TestTypeId,ResourceTagDeclaration} from './generated/vocabulary.ts';
import type { CheckOutcome } from '../../../../contracts/src/tables.ts';

export const PACK = 'defect-to-case';

export const CODES = {
  NOT_FIXED: `${PACK}.not_fixed`,
  SHAPE_INVALID: `${PACK}.shape_invalid`,
  DUPLICATE_DRAFT: `${PACK}.duplicate_draft`,
  NEGATIVE_ACCEPTED: `${PACK}.negative_accepted`,
  UNEXPECTED_REFUTATION: `${PACK}.unexpected_refutation`,
  QUOTE_SOURCE_FORBIDDEN: `${PACK}.quote_source_forbidden`,
  QUOTE_MISSING: `${PACK}.quote_missing`,
  EXPECT_NOT_IN_QUOTE: `${PACK}.expect_not_in_quote`,
  DUPLICATE_CASE: `${PACK}.duplicate_case`,
} as const;

export interface DraftStep {
  identity?:unknown;
  command: string;
  note?: string;
  text?: string;
}

export interface DraftExpected {
  identity?:unknown;
  after?:number;
  text: string;
  quote?: {
    reference: string;
    text: string;
  };
}

export interface DraftCase {
  id?:string;
  title: string;
  priority: number;
  negative: boolean;
  expects_refutation?: boolean;
  preconditions?: string[];
  steps: DraftStep[];
  expected: DraftExpected[];
  tags: string[];
  resource?: unknown;
  tagDeclaration?: ResourceTagDeclaration;
}

export interface DefectItemFields {
  id: string;
  kind?: string;
  title: string;
  status?: string;
  fields?: Record<string, unknown>;
  html_fields?: string[];
  fix_field?: string | null;
  [key: string]: unknown;
}

export const CANONICAL_CATEGORIES = TEST_TYPE_IDS;
export type CanonicalCategory = TestTypeId;
