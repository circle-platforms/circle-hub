// Writes the synthetic mind-map fixtures next to this file: node tests/fixtures/mindmaps/write.ts
// The files are checked into Git; packs/workflow/case-review/functions/fixtures.test.ts checks they equal what documents.ts builds.
import { writeFileSync } from 'node:fs';
import { fixtureFiles } from './documents.ts';

for (const [name, text] of Object.entries(fixtureFiles())) {
  writeFileSync(new URL(`./${name}`, import.meta.url), text);
  console.log(`${name}\t${Buffer.byteLength(text)} bytes`);
}
