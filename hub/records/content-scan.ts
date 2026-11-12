import { scanForCredentials } from './scan.ts';
import type { CredentialScan } from './api.ts';

/**
 * The scan of content (issue 194, decision 154; owner, 2026-11-11): what a business system answers, what a member uploads
 * and what is written into a knowledge space is material for its readers, and nothing in it is withheld, refused or sent
 * for review because it looks like a credential. It finds nothing and says so under its own scanner version, so that a
 * record of the same bytes made under the detectors of credential-scan@3 no longer decides their read tier (the scans of the
 * newest version do). The detectors of scan.ts still guard what the Hub itself writes down about its work: call logs,
 * notes, resource settings, variables and what a dispatch sends out. This lives beside scan.ts and not in it because
 * scan.ts is copied whole into a pack's standalone tool (tools/gen-credential-scanner.ts).
 */
export const CONTENT_SCANNER = 'credential-scan@4';
let contentDetectors = false;
/**
 * Test seam, never called by a running Hub: scan content under the detectors again, in every layer at once, for the tests
 * of the holds, refusals and reviews those detectors made. Records stored under them still follow those rules, and the
 * tests keep them covered until that machinery is removed.
 */
export function useContentDetectors(on: boolean): void { contentDetectors = on; }
export function contentDetectorsOn(): boolean { return contentDetectors; }
export function scanContent(bytes: Uint8Array): CredentialScan {
  return contentDetectors ? scanForCredentials(bytes) : { scanner: CONTENT_SCANNER, inspected: true, clean: true, findings: [], truncated: false };
}
