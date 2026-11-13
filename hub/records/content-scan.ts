import type { CredentialScan } from './api.ts';

/** Content is retained without a credential inspection; this is not a clean-scan assertion. */
export const CONTENT_SCANNER = 'credential-scan@4';
export function scanContent(_bytes: Uint8Array): CredentialScan {
  return { scanner: CONTENT_SCANNER, inspected: false, clean: false, findings: [], truncated: false };
}
