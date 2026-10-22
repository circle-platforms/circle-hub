// Access to the synthetic build-site fixture (files/, written by write.ts): every file by its path below the stub's origin,
// with the media type the site serves it under, ready for a loopback stub (hub/connectors/testing startBuildSiteStub).
import { readdirSync, readFileSync } from 'node:fs';

export { NEW_COMMAND, PAGES, commandTree, fixedBugs, siteFiles } from './write.ts';

const DIR = new URL('./files/', import.meta.url);
const HTML = 'text/html; charset=ISO-8859-1';

export interface SiteFile {
  body: Uint8Array;
  type: string;
}

/** The fixture files as the site serves them: /builds/<name>, HTML pages in ISO-8859-1, trees as XML. */
export function buildSiteFiles(): Record<string, SiteFile> {
  const out: Record<string, SiteFile> = {};
  for (const name of readdirSync(DIR).sort()) {
    const body = new Uint8Array(readFileSync(new URL(name, DIR)));
    out[`/builds/${name}`] = { body, type: name.endsWith('.xml') ? 'application/xml' : HTML };
  }
  return out;
}

/** The base path of the listing pages on the stub (a resource's base URL is <origin><BASE_PATH>). */
export const BASE_PATH = '/builds';
