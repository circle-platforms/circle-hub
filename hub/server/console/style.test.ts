import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DESIGN_CSS } from './style.generated.ts';
import { generateConsoleCss, generatedModule } from '../../../tools/gen-console-style.ts';

const source = () => JSON.parse(readFileSync(new URL('../../../docs/design/circle-design-system/tokens.json', import.meta.url), 'utf8'));
const bundle = readFileSync(new URL('../../../docs/design/circle-design-system/components/bundle.css', import.meta.url), 'utf8');

test('the checked-in stylesheet reproduces every shared source byte with no runtime document reads', () => {
  const css = generateConsoleCss(source(), bundle);
  assert.equal(DESIGN_CSS, css);
  assert.equal(readFileSync(new URL('./style.generated.ts', import.meta.url), 'utf8'), generatedModule(css));
  assert.equal(generateConsoleCss(source(), bundle), css, 'repeated generation is deterministic');
  assert.ok(css.endsWith(bundle), 'the complete component sheet is included verbatim');
  assert.doesNotMatch(generatedModule(css), /import |readFile/);
  assert.match(execFileSync(process.execPath, ['tools/gen-console-style.ts', '--check'], { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' }), /matches the shared design sources/);
  assert.equal(spawnSync(process.execPath, ['tools/gen-console-style.ts', '--unknown'], { cwd: new URL('../../../', import.meta.url) }).status, 2);
});

test('dark defaults, system light and explicit light use all tokens and CSS references', () => {
  const spec = source();
  const css = generateConsoleCss(spec, '');
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const base = blocks.find(([, selector]) => selector.trim() === ':root')![2];
  const system = blocks.find(([, selector]) => selector.trim() === ':root:not([data-theme])')![2];
  const light = blocks.find(([, selector]) => selector.trim() === ':root[data-theme="light"]')![2];
  assert.match(base, /color-scheme: dark/);
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
  assert.equal(system, light, 'an explicit light theme and the light system use identical values');
  const converted = (v: string) => v.replace(/\{([^}]+)\}/g, 'var(--$1)');
  for (const group of ['color', 'spacing', 'radius', 'shadow', 'layout']) {
    for (const token of spec[group].tokens) {
      const darkValue = typeof token.value === 'string' ? token.value : token.value.dark;
      assert.ok(base.includes(`--${token.name}: ${converted(darkValue)};`), `${group}/${token.name}/dark`);
      if (typeof token.value !== 'string') assert.ok(light.includes(`--${token.name}: ${converted(token.value.light)};`), `${group}/${token.name}/light`);
    }
  }
  for (const [family, value] of Object.entries(spec.type.families)) assert.ok(base.includes(`--font-${family}: ${value};`));
  for (const group of spec.type.groups) for (const style of group.styles) {
    assert.ok(base.includes(`--type-${style.name}-size: ${style.fontSize};`));
    assert.ok(base.includes(`--type-${style.name}-line-height: ${style.lineHeight};`));
    assert.ok(base.includes(`--type-${style.name}-weight: ${style.fontWeight};`));
    if (style.letterSpacing) assert.ok(base.includes(`--type-${style.name}-letter-spacing: ${style.letterSpacing};`));
  }
});

test('invalid token inputs fail instead of silently shipping partial or injected CSS', () => {
  const invalid = (mutate: (spec: ReturnType<typeof source>) => void, message: RegExp) => {
    const spec = source(); mutate(spec);
    assert.throws(() => generateConsoleCss(spec, ''), message);
  };
  invalid((s) => { s.color.tokens[0].value.light = '{missing}'; }, /Unknown token reference/);
  invalid((s) => { s.color.tokens[0].value.dark = '{surface-1}'; s.color.tokens[1].value.dark = '{surface-0}'; }, /Cyclic token reference/);
  invalid((s) => { delete s.color.tokens[0].value.light; }, /Invalid CSS token value/);
  invalid((s) => { s.spacing.tokens.push(s.spacing.tokens[0]); }, /Duplicate token/);
  invalid((s) => { s.radius.tokens[0].name = 'invalid;rule'; }, /Invalid token name/);
  invalid((s) => { s.layout.tokens[0].value = '1px;}body{display:none'; }, /Invalid CSS token value/);
  invalid((s) => { s.type.families.sans = '</style><script>unsafe</script>'; }, /Invalid CSS token value/);
  invalid((s) => { s.type.groups[0].family = 'missing'; }, /Unknown font family/);
  invalid((s) => { s.type.groups[0].styles[0].fontWeight = 700; }, /Unsupported font weight/);
  invalid((s) => { s.color.tokens[0].value.dark = '{malformed'; }, /Invalid token reference/);
});
