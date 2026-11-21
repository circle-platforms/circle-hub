// Call categories are model-generated; an unclassified code stays unclassified.
import { CALL_ERROR_CATEGORY_BY_CODE, callErrorCategory as generatedCategory } from '../../contracts/generated/protocol.ts';
import { CALL_ERROR_CATEGORY_LABEL, labelOf, type CallErrorCategory as CategoryCode } from '../../contracts/generated/vocabulary.ts';
export type CallErrorCategory = (typeof CALL_ERROR_CATEGORY_LABEL)[CategoryCode];
export type ErrorPresentation = { kind: 'category'; category: CallErrorCategory } | { kind: 'unavailable' } | { kind: 'conclusion' };
/** Validates the declared namespaced code grammar; it does not establish invocation scope. */
export function isPackScopedCode(code: string): boolean { return /^[a-z][a-z0-9-]{0,40}\.[A-Za-z0-9_.:-]+$/.test(code) && !code.startsWith('core.'); }
export const SOURCE_UNKNOWN_CODES = { SOURCE_UNAVAILABLE: true } as const;
export function errorPresentationOf(code: string, packageInvocation = false): ErrorPresentation {
  if (code === 'SOURCE_UNAVAILABLE') return { kind: 'unavailable' };
  const category = generatedCategory(code, packageInvocation);
  return category === null ? { kind: 'conclusion' } : { kind: 'category', category: labelOf('call_error_category', category) as CallErrorCategory };
}
export function callErrorCategoryOf(code: string, packageInvocation = false): CallErrorCategory | null {
  const value = errorPresentationOf(code, packageInvocation);
  return value.kind === 'category' ? value.category : null;
}
export function categoryTableEntries(): ReadonlyArray<readonly [string, CallErrorCategory]> {
  return Object.entries(CALL_ERROR_CATEGORY_BY_CODE).flatMap(([code, category]) => category === null ? [] : [[code, labelOf('call_error_category', category) as CallErrorCategory] as const]);
}
