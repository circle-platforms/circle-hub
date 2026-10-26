// Access to the synthetic manual-store fixture (files/, written by write.ts): every file by its path below the store root,
// as text (the CLI manuals restore their escaped synthetic NUL bytes), ready for a WebDAV loopback stub (hub/connectors/testing startWebDavStub).
import { readdirSync, readFileSync, statSync } from 'node:fs';

export { storeFiles } from './write.ts';

const ROOT = new URL('./files/', import.meta.url);

function walk(dir: URL, prefix: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    const url = new URL(encodeURIComponent(name), dir);
    if (statSync(url).isDirectory()) walk(new URL(`${encodeURIComponent(name)}/`, dir), `${prefix}/${name}`, out);
    else out[`${prefix}/${name}`] = readFileSync(url, 'utf8').replaceAll('\\u0000', String.fromCharCode(0));
  }
}

/** The fixture files by path (/spec/..., /cli/<folder>/cli_cn/cli_cn.md, ...). */
export function manualStoreFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  walk(ROOT, '', out);
  return out;
}

/**
 * Invented search terms of the synthetic spec search (two Han terms, an ASCII acronym and a common word), and the two spec
 * files a search for them must rank first: the acronym counts only where no ASCII letter touches it (TTLOG does not match),
 * and on a tie the file whose terms are rarer in the folder comes first.
 */
export const SPEC_SEARCH_TERMS = ['信标组', '权重继承', 'TTL', '配置'];
export const SPEC_SEARCH_FILES = ['信标组(TTL)权重继承.md', '信标组TTL的配置.md'];
/** A sentence of the first of those files, to find in the derived content. */
export const SPEC_SEARCH_TEXT = '信标组可以包含 1 到 8 个信标';
/** The strategy document a test-strategy search for the same feature finds in qa/. */
export const QA_SEARCH_FILE = '信标组测试策略.md';
