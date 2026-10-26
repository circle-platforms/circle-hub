// The documents of the Lumen API product in a synthetic document store (not part of the pack): the release list and the
// endpoint references of the released builds, by path below the store root, for hub/connectors/testing startWebDavStub
// (the manual-store system pack reads them as manual:file:<path>). Everything invented.
import { readFileSync } from 'node:fs';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export const REVIEW_MINDMAP = 'lumen-review.km.json';
export const RELEASED = 'lumen-2.1.0-b7';
export const OLDER = 'lumen-2.0.4-b30';

/** The 2.0.4 reference: the same endpoints without DELETE (it came with 2.1.0). */
function olderReference(): string {
  const text = fixture('endpoints-2.1.0.md').replace('2.1.0', '2.0.4');
  const start = text.indexOf('## DELETE');
  const end = text.indexOf('## GET /v1/health');
  return text.slice(0, start) + text.slice(end);
}

export function lumenFiles(): Record<string, string> {
  return {
    '/lumen/releases.md': fixture('releases.md'),
    '/lumen/2.1.0/endpoints.md': fixture('endpoints-2.1.0.md'),
    '/lumen/2.0.4/endpoints.md': olderReference(),
  };
}

export function reviewMindmap(): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${REVIEW_MINDMAP}`, import.meta.url)));
}
