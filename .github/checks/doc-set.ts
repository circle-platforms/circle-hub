import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isHistorical, trackedFileText } from './docs-rules.ts';

export const DOC_SET_PATH = '.github/checks/doc-set.json';
export const EXCEPTIONS_PATH = '.github/checks/exceptions.json';

export interface DocSet {
  readonly published: readonly string[];
  readonly kept_internal: readonly string[];
  readonly historical: readonly string[];
  readonly reserved: readonly string[];
}

export type DocSetViolationKind = 'unlisted' | 'historical';

export interface DocSetException {
  readonly check: string;
  readonly path: string;
  readonly what: DocSetViolationKind;
  readonly reason: string;
  readonly removeWhen: string;
}

export interface DocSetSnapshot {
  readonly files: readonly string[];
  readonly historicalFiles: readonly string[];
  readonly siteExcludes?: readonly string[];
}

type DocSetSection = 'published' | 'kept_internal' | 'historical' | 'reserved';

const DOC_SET_KEYS = new Set<string>(['published', 'kept_internal', 'historical', 'reserved']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function jekyllSkips(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.') || name === 'vendor';
}

export function parseSiteExcludes(configYaml: string): string[] {
  const block = /^exclude:\n((?:[ \t]+.*(?:\n|$)|\n)+)/m.exec(configYaml);
  if (block === null) throw new Error('docs/_config.yml has no exclude list');
  return [...block[1].matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((match) => match[1]);
}

export function isJekyllSkipped(insideDocsPath: string, excludes: readonly string[]): boolean {
  if (insideDocsPath.split('/').some(jekyllSkips)) return true;
  return excludes.some((entry) => insideDocsPath.startsWith(entry));
}

export function isValidDocsPath(path: string): boolean {
  return path.startsWith('docs/') && path.length > 'docs/'.length && !path.endsWith('/') && !path.includes('\\') && posix.normalize(path) === path;
}

function parsePathList(
  value: unknown,
  section: DocSetSection,
  required: boolean,
  excludes?: readonly string[],
): { valid: string[]; broken: boolean; problems: string[] } {
  if (value === undefined && !required) return { valid: [], broken: false, problems: [] };
  if (!Array.isArray(value)) {
    return { valid: [], broken: true, problems: [`${DOC_SET_PATH}: ${section} must be an array of paths`] };
  }
  const problems: string[] = [];
  const valid: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isNonEmptyString(item)) {
      problems.push(`${DOC_SET_PATH}: ${section}[${index}] must be a non-empty string`);
      continue;
    }
    if (!isValidDocsPath(item)) {
      problems.push(`${DOC_SET_PATH}: ${section}[${index}] ${JSON.stringify(item)} must be a canonical repo-relative path under docs/`);
      continue;
    }
    if ((section === 'published' || section === 'historical' || section === 'reserved') && !item.endsWith('.md')) {
      problems.push(`${DOC_SET_PATH}: ${section} entry ${item} must end with .md`);
      continue;
    }
    if (seen.has(item)) {
      problems.push(`${DOC_SET_PATH}: duplicate ${section} entry ${item}`);
      continue;
    }
    seen.add(item);
    if ((section === 'published' || section === 'reserved') && isJekyllSkipped(item.slice('docs/'.length), excludes ?? [])) {
      problems.push(`${DOC_SET_PATH}: ${section} entry ${item} is excluded from the docs site`);
    }
    valid.push(item);
  }
  return { valid, broken: false, problems };
}

export function parseDocSet(raw: unknown, excludes?: readonly string[]): { docSet?: DocSet; problems: string[] } {
  if (!isRecord(raw)) {
    return { problems: [`${DOC_SET_PATH}: root must be a JSON object`] };
  }
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!DOC_SET_KEYS.has(key)) problems.push(`${DOC_SET_PATH}: unknown key ${JSON.stringify(key)}`);
  }
  const published = parsePathList(raw.published, 'published', true, excludes);
  const keptInternal = parsePathList(raw.kept_internal, 'kept_internal', true, excludes);
  const historical = parsePathList(raw.historical, 'historical', false, excludes);
  const reserved = parsePathList(raw.reserved, 'reserved', false, excludes);
  problems.push(...published.problems, ...keptInternal.problems, ...historical.problems, ...reserved.problems);
  if (published.broken || keptInternal.broken || historical.broken || reserved.broken) {
    return { problems };
  }
  const publishedSet = new Set(published.valid);
  const keptSet = new Set(keptInternal.valid);
  for (const path of keptInternal.valid) {
    if (publishedSet.has(path)) {
      problems.push(`${DOC_SET_PATH}: ${path} cannot appear in both published and kept_internal`);
    } else if (excludes !== undefined && path.endsWith('.md') && !isJekyllSkipped(path.slice('docs/'.length), excludes)) {
      problems.push(`${DOC_SET_PATH}: kept_internal page ${path} is not excluded from the docs site; list it in published instead`);
    }
  }
  for (const path of historical.valid) {
    if (!publishedSet.has(path) && !keptSet.has(path)) {
      problems.push(`${DOC_SET_PATH}: historical entry ${path} must also be listed in published or kept_internal`);
    }
  }
  for (const path of reserved.valid) {
    if (publishedSet.has(path) || keptSet.has(path)) {
      problems.push(`${DOC_SET_PATH}: reserved entry ${path} cannot already appear in published or kept_internal`);
    }
  }
  return {
    docSet: {
      published: published.valid,
      kept_internal: keptInternal.valid,
      historical: historical.valid,
      reserved: reserved.valid,
    },
    problems,
  };
}

export function parseDocSetExceptions(raw: unknown): { entries: DocSetException[]; problems: string[] } {
  if (raw === undefined) return { entries: [], problems: [] };
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.exceptions) ? raw.exceptions : null;
  if (list === null) {
    return { entries: [], problems: [`${EXCEPTIONS_PATH}: expected an array or { exceptions: [...] }`] };
  }
  const entries: DocSetException[] = [];
  const problems: string[] = [];
  const seenKeys = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!isRecord(item)) {
      problems.push(`${EXCEPTIONS_PATH}: entry[${index}] must be an object`);
      continue;
    }
    if (!isNonEmptyString(item.check)) {
      problems.push(`${EXCEPTIONS_PATH}: entry[${index}].check must be a non-empty string`);
      continue;
    }
    if (item.check !== 'doc-set') continue;
    const path = item.path;
    const what = item.what;
    const reason = item.reason;
    const removeWhen = item.removeWhen;
    let valid = true;
    if (!isNonEmptyString(path) || !isValidDocsPath(path)) {
      problems.push(`${EXCEPTIONS_PATH}: entry[${index}].path ${JSON.stringify(path)} must be a canonical repo-relative path under docs/`);
      valid = false;
    }
    if (what !== 'unlisted' && what !== 'historical') {
      problems.push(`${EXCEPTIONS_PATH}: entry[${index}].what ${JSON.stringify(what)} must be "unlisted" or "historical"`);
      valid = false;
    }
    if (!isNonEmptyString(reason)) {
      problems.push(`${EXCEPTIONS_PATH}: entry[${index}].reason must be a non-empty string`);
      valid = false;
    }
    if (!isNonEmptyString(removeWhen)) {
      problems.push(`${EXCEPTIONS_PATH}: entry[${index}].removeWhen must be a non-empty string`);
      valid = false;
    }
    if (!valid) continue;
    const key = `${path as string}\0${what as DocSetViolationKind}`;
    if (seenKeys.has(key)) {
      problems.push(`${EXCEPTIONS_PATH}: duplicate doc-set exception for ${path as string} (${what as string})`);
      continue;
    }
    seenKeys.add(key);
    entries.push({
      check: 'doc-set',
      path: path as string,
      what: what as DocSetViolationKind,
      reason: reason as string,
      removeWhen: removeWhen as string,
    });
  }
  return { entries, problems };
}

export function docSetProblemsFromSnapshot(snapshot: DocSetSnapshot, docSetRaw: unknown, exceptionsRaw?: unknown): string[] {
  const parsedDocSet = parseDocSet(docSetRaw, snapshot.siteExcludes);
  const parsedExceptions = parseDocSetExceptions(exceptionsRaw);
  const problems = [...parsedDocSet.problems, ...parsedExceptions.problems];
  if (parsedDocSet.docSet === undefined) return problems;

  const { published, kept_internal, historical, reserved } = parsedDocSet.docSet;
  const actualSet = new Set(snapshot.files);
  const actualHistoricalSet = new Set(snapshot.historicalFiles);
  const declaredPublished = new Set(published);
  const declaredKept = new Set(kept_internal);
  const declaredHistorical = new Set(historical);
  const declaredReserved = new Set(reserved);
  const exceptionByKey = new Map<string, DocSetException>();
  for (const entry of parsedExceptions.entries) {
    exceptionByKey.set(`${entry.path}\0${entry.what}`, entry);
  }
  const matchedKeys = new Set<string>();

  for (const path of published) {
    if (!actualSet.has(path)) {
      problems.push(`${path}: listed in ${DOC_SET_PATH} (published) but missing on disk or untracked`);
    }
  }
  for (const path of kept_internal) {
    if (!actualSet.has(path)) {
      problems.push(`${path}: listed in ${DOC_SET_PATH} (kept_internal) but missing on disk or untracked`);
    }
  }
  for (const path of snapshot.files) {
    if (declaredPublished.has(path) || declaredKept.has(path) || declaredReserved.has(path)) continue;
    const key = `${path}\0unlisted`;
    if (exceptionByKey.has(key)) matchedKeys.add(key);
    else problems.push(`${path}: unlisted file under docs/ (add to ${DOC_SET_PATH} or register in ${EXCEPTIONS_PATH})`);
  }
  for (const path of historical) {
    if (actualSet.has(path) && !actualHistoricalSet.has(path)) {
      problems.push(`${path}: listed in ${DOC_SET_PATH} (historical) but does not open with a historical or superseded banner`);
    }
  }
  for (const path of snapshot.historicalFiles) {
    if (!actualSet.has(path) || declaredHistorical.has(path)) continue;
    const key = `${path}\0historical`;
    if (exceptionByKey.has(key)) matchedKeys.add(key);
    else problems.push(`${path}: opens with a historical or superseded banner (remove the banner or move historical records to git history)`);
  }
  for (const [key, entry] of exceptionByKey) {
    if (!matchedKeys.has(key)) {
      problems.push(`${entry.path}: stale doc-set exception (${entry.what}) in ${EXCEPTIONS_PATH} has no live hit (removeWhen: ${entry.removeWhen})`);
    }
  }
  return problems;
}

function readJsonFile(fullPath: string, label: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(fullPath, 'utf8')) as unknown };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `${label}: invalid JSON (${detail})` };
  }
}

function readOptionalExcludes(root: string): { excludes?: string[]; error?: string } {
  const configPath = join(root, 'docs/_config.yml');
  if (!existsSync(configPath)) return {};
  try {
    return { excludes: parseSiteExcludes(readFileSync(configPath, 'utf8')) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `docs/_config.yml: ${detail}` };
  }
}

function trackedExists(fullPath: string): boolean {
  try {
    const info = lstatSync(fullPath);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}

export function loadDocSet(root: string): DocSet {
  const docSetFile = join(root, DOC_SET_PATH);
  const parsedJson = readJsonFile(docSetFile, DOC_SET_PATH);
  if (parsedJson.error !== undefined) throw new Error(parsedJson.error);
  const config = readOptionalExcludes(root);
  if (config.error !== undefined) throw new Error(config.error);
  const { docSet, problems } = parseDocSet(parsedJson.value, config.excludes);
  if (problems.length > 0 || docSet === undefined) throw new Error(problems.join('\n'));
  return docSet;
}

export function docSetProblems(root: string): string[] {
  const docSetFile = join(root, DOC_SET_PATH);
  if (!existsSync(docSetFile)) return [`${DOC_SET_PATH}: missing file`];
  const docSetJson = readJsonFile(docSetFile, DOC_SET_PATH);
  if (docSetJson.error !== undefined) return [docSetJson.error];

  const exceptionsFile = join(root, EXCEPTIONS_PATH);
  let exceptionsRaw: unknown;
  if (existsSync(exceptionsFile)) {
    const exceptionsJson = readJsonFile(exceptionsFile, EXCEPTIONS_PATH);
    if (exceptionsJson.error !== undefined) return [exceptionsJson.error];
    exceptionsRaw = exceptionsJson.value;
  }

  const config = readOptionalExcludes(root);
  if (config.error !== undefined) return [config.error];

  let listed: string;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--', 'docs'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return ['git file list failed'];
  }

  const files: string[] = [];
  const historicalFiles: string[] = [];
  for (const path of listed.split('\0')) {
    if (path === '') continue;
    const fullPath = join(root, path);
    if (!trackedExists(fullPath)) continue;
    files.push(path);
    if (path.endsWith('.md')) {
      const text = trackedFileText(fullPath);
      if (text !== null && isHistorical(text)) historicalFiles.push(path);
    }
  }
  return docSetProblemsFromSnapshot({ files, historicalFiles, siteExcludes: config.excludes }, docSetJson.value, exceptionsRaw);
}
