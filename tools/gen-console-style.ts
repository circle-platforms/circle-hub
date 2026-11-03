// Generates the console's self-contained stylesheet from the shared design sources. No runtime file reads.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const OUTPUT = 'hub/server/console/style.generated.ts';

// PR #135 is normative on main; keep the older shared folder byte-identical until the scheduled rebase.
export const INTERACTION_CSS = `
/* PR #135: contrast on composed hover, selected and pressed surfaces. */
:is(.ch-row:hover,.ch-row.is-selected,.ch-row[aria-current],.ch-table tr:hover,.ch-table tr.is-selected,.ch-table tr[aria-selected="true"],.ch-nav-item:hover,.ch-nav-item[aria-current],.ch-nav-sub a:hover,.ch-nav-sub a[aria-current]) :is(.ch-meta,.ch-row-meta,.ch-time,.ch-count,.ch-section-label,.ch-field-hint,.ch-kv dt,time){color:var(--text-secondary)}
:is(.ch-row:hover,.ch-row.is-selected,.ch-row[aria-current],.ch-table tr:hover,.ch-table tr.is-selected,.ch-table tr[aria-selected="true"]) a:not(.ch-btn){color:var(--text-primary)}
.ch-table tbody tr.is-selected:hover td{background:color-mix(in srgb,var(--area) 8%,transparent)}
:is(.ch-chip[aria-pressed="true"],.ch-chip[aria-current],.ch-seg button[aria-selected="true"],.ch-seg button[aria-checked="true"],.ch-seg a[aria-current]){box-shadow:inset 0 0 0 1px var(--focus-ring)}
:is(.ch-btn--primary,.ch-btn--secondary,.ch-btn--danger,.ch-btn--ghost,.ch-chip,.ch-seg button,.ch-seg a,.ch-icon-btn):active{box-shadow:inset 0 0 0 1px var(--focus-ring)}
`;

type ThemeValue = string | { dark: string; light: string };
type Fields = Record<string, unknown>;

function object(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a token object');
  return value as Fields;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Expected a nonempty token list');
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value)) throw new Error('Invalid token name');
  return value;
}

function cssValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[;<>\\\n\r]/.test(value)) throw new Error('Invalid CSS token value');
  const bare = value.replace(/\{[a-z][a-z0-9-]*\}/g, '');
  if (/[{}]/.test(bare)) throw new Error('Invalid token reference');
  return value;
}

/** Validate references per theme before emitting var(), including references crossing token groups. */
export function generateConsoleCss(input: unknown, bundle: string): string {
  const spec = object(input);
  const values = new Map<string, ThemeValue>();
  const add = (key: string, value: ThemeValue) => {
    if (values.has(key)) throw new Error(`Duplicate token: ${key}`);
    values.set(key, value);
  };
  for (const group of ['color', 'spacing', 'radius', 'shadow', 'layout']) {
    for (const item of array(object(spec[group]).tokens)) {
      const token = object(item);
      const key = name(token.name);
      if (typeof token.value === 'string') add(key, cssValue(token.value));
      else {
        const value = object(token.value);
        add(key, { dark: cssValue(value.dark), light: cssValue(value.light) });
      }
    }
  }
  const type = object(spec.type);
  for (const [family, value] of Object.entries(object(type.families))) add(`font-${name(family)}`, cssValue(value));
  for (const group of array(type.groups)) {
    const entry = object(group);
    const family = name(entry.family);
    if (!values.has(`font-${family}`)) throw new Error(`Unknown font family: ${family}`);
    for (const item of array(entry.styles)) {
      const style = object(item);
      const key = name(style.name);
      add(`type-${key}-family`, `{font-${family}}`);
      for (const [field, suffix] of [['fontSize', 'size'], ['lineHeight', 'line-height'], ['fontWeight', 'weight'], ['letterSpacing', 'letter-spacing']]) {
        if (field === 'letterSpacing' && style[field] === undefined) continue;
        const value = style[field];
        if (field === 'fontWeight' && ![400, 500, 600].includes(value as number)) throw new Error('Unsupported font weight');
        add(`type-${key}-${suffix}`, cssValue(typeof value === 'number' ? String(value) : value));
      }
    }
  }
  const reference = /\{([a-z][a-z0-9-]*)\}/g;
  const at = (key: string, theme: 'dark' | 'light'): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Unknown token reference: ${key}`);
    return typeof value === 'string' ? value : value[theme];
  };
  for (const theme of ['dark', 'light'] as const) {
    const done = new Set<string>();
    const visiting = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) throw new Error(`Cyclic token reference: ${key}`);
      if (done.has(key)) return;
      visiting.add(key);
      for (const match of at(key, theme).matchAll(reference)) visit(match[1]);
      visiting.delete(key);
      done.add(key);
    };
    for (const key of values.keys()) visit(key);
  }
  const declarations = (theme: 'dark' | 'light', common: boolean) => [
    `  color-scheme: ${theme};`,
    ...[...values].filter(([, value]) => common || typeof value !== 'string').map(([key]) =>
      `  --${key}: ${at(key, theme).replace(reference, (_, ref: string) => `var(--${ref})`)};`),
  ].join('\n');
  return `:root {\n${declarations('dark', true)}\n}\n` +
    `@media (prefers-color-scheme: light) {\n:root:not([data-theme]) {\n${declarations('light', false)}\n}\n}\n` +
    `:root[data-theme="light"] {\n${declarations('light', false)}\n}\n` +
    `\n${bundle}\n${INTERACTION_CSS}`;
}

export function generatedModule(css: string): string {
  const literal = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return '// Generated by node tools/gen-console-style.ts from the shared tokens.json and components/bundle.css.\n' +
    '// Shared design by Circle and qingshanfeihu, CC BY 4.0; shared component bytes retained, followed by the PR-135 interaction rules.\n' +
    '// Source: https://github.com/circle-platforms/circle-hub/tree/main/docs/design/circle-design-system\n' +
    '// Do not edit by hand; the console does not read design documents at runtime.\n' +
    `export const DESIGN_CSS = \`${literal}\`;\n`;
}

export function main(args: string[]): number {
  if (args.some((arg) => arg !== '--check') || args.length > 1) {
    process.stderr.write('Usage: node tools/gen-console-style.ts [--check]\n');
    return 2;
  }
  const css = generateConsoleCss(JSON.parse(readFileSync(new URL('docs/design/circle-design-system/tokens.json', ROOT), 'utf8')),
    readFileSync(new URL('docs/design/circle-design-system/components/bundle.css', ROOT), 'utf8'));
  const output = generatedModule(css);
  const target = new URL(OUTPUT, ROOT);
  if (args.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== output) {
      process.stderr.write(`${OUTPUT} is stale; run node tools/gen-console-style.ts\n`);
      return 1;
    }
    process.stdout.write(`${OUTPUT} matches the shared design sources\n`);
  } else {
    writeFileSync(target, output);
    process.stdout.write(`Generated ${OUTPUT}\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
