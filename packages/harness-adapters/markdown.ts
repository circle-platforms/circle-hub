import type { AdapterWarning, HubManifest } from './neutral.ts';
import { deepEqual } from './files.ts';
import {
  parseFrontmatter,
  parseNameList,
  scalar,
  serializeFrontmatter,
  splitFrontmatter,
} from './frontmatter.ts';

// Generic engine for markdown primitives (skill / agent / command /
// instruction): frontmatter is rewritten from the manifest, the body always
// comes from the original file bytes handed to exportTo. A manifest that
// still matches its source file exports the file byte-identically.

export type MarkdownKind = 'hub-skill/1' | 'hub-agent/1' | 'hub-command/1' | 'hub-instruction/1';

export type NeutralField = 'name' | 'description' | 'model' | 'tools' | 'arguments' | 'applies';
export type SpecificSlot = 'allowedTools' | 'argumentHint';

export interface MarkdownSpec {
  kind: MarkdownKind;
  // frontmatter key -> neutral manifest field
  fields: Record<string, NeutralField>;
  // frontmatter key -> harnessSpecific slot (kept outside the neutral fields)
  specific: Record<string, SpecificSlot>;
  // true when the format names the primitive in frontmatter (skill/agent);
  // false when the file name is the name (command) or there is no name
  frontmatterName: boolean;
}

export interface MarkdownDerived {
  neutral: {
    name?: string;
    description?: string;
    model?: string;
    tools?: string[];
    arguments?: string;
    applies?: string[];
  };
  specific: { allowedTools?: string[]; argumentHint?: string };
  proprietary: Record<string, string | string[]>;
  frontmatterKeys: string[];
  hadFrontmatter: boolean;
  body: string;
}

const LIST_FIELDS: ReadonlyArray<NeutralField | SpecificSlot> = ['tools', 'applies', 'allowedTools'];

export function deriveMarkdown(
  path: string,
  text: string,
  defaultName: string | undefined,
  spec: MarkdownSpec,
  warnings: AdapterWarning[],
): MarkdownDerived {
  const split = splitFrontmatter(text);
  if (split.unclosed) {
    warnings.push({
      code: 'FRONTMATTER_UNCLOSED',
      path,
      detail: 'opening --- has no closing ---; the file is treated as plain markdown with no frontmatter fields',
    });
  }
  const derived: MarkdownDerived = {
    neutral: {},
    specific: {},
    proprietary: {},
    frontmatterKeys: [],
    hadFrontmatter: split.hasFrontmatter,
    body: split.body,
  };
  if (split.hasFrontmatter) {
    const parsed = parseFrontmatter(split.frontmatter);
    for (const badLine of parsed.badLines) {
      warnings.push({
        code: 'FRONTMATTER_LINE_SKIPPED',
        path,
        detail: `frontmatter line ${badLine.line + 2} is outside the supported subset and was skipped`,
      });
    }
    derived.frontmatterKeys = Object.keys(parsed.values);
    for (const [key, value] of Object.entries(parsed.values)) {
      const field = spec.fields[key];
      if (field !== undefined) {
        (derived.neutral as Record<string, unknown>)[field] = LIST_FIELDS.includes(field) ? parseNameList(value) : scalar(value);
        continue;
      }
      const slot = spec.specific[key];
      if (slot !== undefined) {
        (derived.specific as Record<string, unknown>)[slot] = LIST_FIELDS.includes(slot) ? parseNameList(value) : scalar(value);
        continue;
      }
      derived.proprietary[key] = value;
    }
  }
  if (spec.frontmatterName) {
    const name = derived.neutral.name;
    if (name === undefined || name === '') {
      derived.neutral.name = defaultName;
      warnings.push({
        code: 'NAME_DERIVED_FROM_PATH',
        path,
        detail: 'frontmatter key "name" is missing; the name is derived from the file location',
      });
    }
  } else if (defaultName !== undefined) {
    derived.neutral.name = defaultName;
  }
  return derived;
}

// harnessSpecific carried by markdown manifests: locations and unmapped
// frontmatter keys only, never file bytes.
export function markdownHarnessSpecific(
  path: string,
  derived: MarkdownDerived,
): Record<string, unknown> {
  return {
    path,
    hadFrontmatter: derived.hadFrontmatter,
    frontmatterKeys: derived.frontmatterKeys,
    ...(Object.keys(derived.proprietary).length > 0 ? { frontmatter: derived.proprietary } : {}),
    ...(derived.specific.allowedTools !== undefined ? { allowedTools: derived.specific.allowedTools } : {}),
    ...(derived.specific.argumentHint !== undefined ? { argumentHint: derived.specific.argumentHint } : {}),
  };
}

function manifestValue(manifest: HubManifest, field: NeutralField): string | string[] | undefined {
  const value = (manifest as unknown as Record<string, unknown>)[field];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value as string[];
  return undefined;
}

function resolveKey(
  key: string,
  spec: MarkdownSpec,
  manifest: HubManifest,
  specific: Record<string, unknown>,
): string | string[] | undefined {
  const field = spec.fields[key];
  if (field !== undefined) return manifestValue(manifest, field);
  const slot = spec.specific[key];
  if (slot !== undefined) {
    const value = specific[slot];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value as string[];
    return undefined;
  }
  const frontmatter = specific.frontmatter as Record<string, string | string[]> | undefined;
  return frontmatter?.[key];
}

function isEmptyValue(value: string | string[] | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

// Rebuild the file for a markdown manifest. `original` is the current source
// bytes from the file table handed to exportTo. Returns undefined when the
// source file is missing.
export function exportMarkdownFile(
  manifest: HubManifest,
  spec: MarkdownSpec,
  defaultName: string | undefined,
  original: string,
  path: string,
): string {
  const derived = deriveMarkdown(path, original, defaultName, spec, []);
  const specific = manifest.harnessSpecific as Record<string, unknown>;

  const unchanged =
    derived.hadFrontmatter === (specific.hadFrontmatter === true) &&
    specFieldsEqual(spec, manifest, specific, derived);
  if (unchanged) return original;

  const pairs: Array<[string, string | string[]]> = [];
  const seen = new Set<string>();
  for (const key of derived.frontmatterKeys) {
    seen.add(key);
    const value = resolveKey(key, spec, manifest, specific);
    if (value !== undefined && !isEmptyValue(value)) pairs.push([key, value]);
  }
  for (const [key, field] of Object.entries(spec.fields)) {
    if (seen.has(key)) continue;
    const value = manifestValue(manifest, field);
    // A name equal to the file-derived default is not written: the location
    // already says it.
    if (field === 'name' && value === defaultName) continue;
    if (value !== undefined && !isEmptyValue(value)) pairs.push([key, value]);
  }
  for (const [key, slot] of Object.entries(spec.specific)) {
    if (seen.has(key)) continue;
    const value = specific[slot] as string | string[] | undefined;
    if (value !== undefined && !isEmptyValue(value)) pairs.push([key, value]);
  }
  const frontmatter = specific.frontmatter as Record<string, string | string[]> | undefined;
  for (const key of Object.keys(frontmatter ?? {})) {
    if (seen.has(key)) continue;
    const value = frontmatter![key];
    if (!isEmptyValue(value)) pairs.push([key, value]);
  }
  if (pairs.length === 0) return derived.body;
  return `---\n${serializeFrontmatter(pairs)}\n---\n${derived.body}`;
}

function specFieldsEqual(
  spec: MarkdownSpec,
  manifest: HubManifest,
  specific: Record<string, unknown>,
  derived: MarkdownDerived,
): boolean {
  for (const field of Object.values(spec.fields)) {
    if (!deepEqual(manifestValue(manifest, field) ?? emptyField(field), derived.neutral[field] ?? emptyField(field))) {
      return false;
    }
  }
  for (const slot of Object.values(spec.specific)) {
    if (!deepEqual(specific[slot] ?? undefined, derived.specific[slot] ?? undefined)) return false;
  }
  const frontmatter = (specific.frontmatter ?? {}) as Record<string, string | string[]>;
  return deepEqual(frontmatter, derived.proprietary);
}

function emptyField(field: NeutralField): string | string[] {
  return LIST_FIELDS.includes(field) ? [] : '';
}
