// The `.pathname` of `new URL(…, import.meta.url)` is a URL path, not a file path: it percent-encodes every non-ASCII character
// (a checkout under 开发 becomes %E5%BC%80%E5%8F%91) and keeps the leading slash before a Windows drive letter, so a
// test or tool that uses it fails wherever the repository lives under such a path. fileURLToPath() is the conversion.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const URL_PATHNAME = /import\.meta\.url\)\.pathname\b/;

/** Third-party sources kept byte for byte, each with the reason its use is harmless. */
export const ALLOWED: Readonly<Record<string, string>> = {
  'packs/product/famx/functions/adoc/vendor/core.mjs': 'vendored Asciidoctor port; it computes LIB_DIR, ROOT_DIR and DATA_DIR but never reads them',
};

/** Each line of one source that converts import.meta.url with .pathname, as `<file>:<line>`. */
export function urlPathnameUses(file: string, source: string): string[] {
  if (Object.hasOwn(ALLOWED, file)) return [];
  return source.split('\n').flatMap((line, index) => (URL_PATHNAME.test(line) ? [`${file}:${index + 1}`] : []));
}

export function urlPathnameProblems(root: string): string[] {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.mjs', '*.js'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0')
    .filter((file) => file !== '' && !file.startsWith('foundation/') && !file.startsWith('references/'));
  return files.flatMap((file) => urlPathnameUses(file, readFileSync(join(root, file), 'utf8')));
}
