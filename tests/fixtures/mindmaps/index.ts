// Access to the synthetic mind-map fixtures for tests of any package. The large document (about 3,000 nodes) is not a
// file: build it with largeDocument() from documents.ts and take its bytes with compactText().
import { readFileSync } from 'node:fs';

export { compactText, largeDocument } from './documents.ts';

export const MINDMAP_FIXTURES = [
  'review-150.km.json',
  'review-150.double.json',
  'review-150.agile-response.json',
  'tiny.km.json',
  'untagged.km.json',
  'outline.km.json',
  'template.km.json',
] as const;
export type MindmapFixture = (typeof MINDMAP_FIXTURES)[number];

export function fixtureUrl(name: MindmapFixture): URL {
  return new URL(`./${name}`, import.meta.url);
}

export function fixtureBytes(name: MindmapFixture): Uint8Array {
  return new Uint8Array(readFileSync(fixtureUrl(name)));
}

export function fixtureText(name: MindmapFixture): string {
  return readFileSync(fixtureUrl(name), 'utf8');
}
