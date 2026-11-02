import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'parse5';
import { CONTENT_SECURITY_POLICY, FAVICON_SVG, THEME_SCRIPT_HASH, html, page } from './html.ts';
import { CSS } from './style.ts';
import { THEME_SCRIPT } from './theme.ts';

/** A deliberately small DOM: no fetch or EventSource is provided, so this script cannot open a connection. */
function browser(saved: string | null = null, blocked = false) {
  const attributes = new Map<string, string>();
  const stored = new Map<string, string>(saved === null ? [] : [['circle-hub-theme', saved]]);
  const events = new Map<string, (event: Record<string, unknown>) => void>();
  class Button {
    dataset: { themeChoice: string };
    attributes = new Map<string, string>();
    tabIndex = -1;
    focused = false;
    get parentElement() { return control; }
    constructor(choice: string) { this.dataset = { themeChoice: choice }; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    closest(selector: string) { return selector === '[data-theme-switch] [data-theme-choice]' ? this : null; }
    focus() { this.focused = true; }
  }
  const buttons = ['system', 'light', 'dark'].map((choice) => new Button(choice));
  const control = { hidden: true, querySelectorAll: () => buttons };
  const search = {focused:false,focus(){this.focused=true;}};
  const navigation = {checked:false};
  let mounted = false;
  const storage = {
    getItem(key: string) { if (blocked) throw new Error('blocked'); return stored.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw new Error('blocked'); stored.set(key, value); },
    removeItem(key: string) { if (blocked) throw new Error('blocked'); stored.delete(key); },
  };
  runInNewContext(THEME_SCRIPT, {
    Element: Button,
    document: {
      documentElement: {
        setAttribute(key: string, value: string) { attributes.set(key, value); },
        removeAttribute(key: string) { attributes.delete(key); },
      },
      querySelectorAll: () => mounted ? [control] : [],
      getElementById: (id:string) => id==='console-search'?search:id==='console-navigation-toggle'?navigation:null,
      addEventListener: (name: string, fn: (event: Record<string, unknown>) => void) => events.set(name, fn),
    },
    localStorage: storage,
    window: { addEventListener: (name: string, fn: (event: Record<string, unknown>) => void) => events.set(name, fn) },
  });
  return {
    attributes, stored, control, buttons, search, navigation,
    mount() { mounted = true; events.get('DOMContentLoaded')!({}); },
    click(choice: string) { events.get('click')!({ target: buttons.find((b) => b.dataset.themeChoice === choice) ?? new Button(choice) }); },
    external(value: string | null) { if (value === null) stored.delete('circle-hub-theme'); else stored.set('circle-hub-theme', value); events.get('storage')!({ key: 'circle-hub-theme' }); },
    irrelevantClick() { events.get('click')!({ target: {} }); },
    key(choice: string, key: string) {
      let prevented=false;
      events.get('keydown')!({target:buttons.find((b)=>b.dataset.themeChoice===choice),key,preventDefault(){prevented=true;}});
      return prevented;
    },
    searchShortcut(){events.get('keydown')!({key:'k',ctrlKey:true,preventDefault(){}});},
  };
}

test('a saved theme is restored in the head before controls exist, without starting live updates', () => {
  for (const theme of ['dark', 'light']) {
    const b = browser(theme);
    assert.equal(b.attributes.get('data-theme'), theme);
    assert.equal(b.control.hidden, true);
    b.mount();
    assert.equal(b.control.hidden, false);
    for (const button of b.buttons) assert.equal(button.attributes.get('aria-checked'), String(button.dataset.themeChoice === theme));
  }
});

test('the segmented theme selector uses radio state and wraps keyboard selection',()=>{
  const b=browser();b.mount();
  assert.equal(b.buttons[0].tabIndex,0);assert.equal(b.buttons[1].tabIndex,-1);
  assert.equal(b.key('system','ArrowLeft'),true);assert.equal(b.attributes.get('data-theme'),'dark');assert.ok(b.buttons[2].focused);
  assert.equal(b.key('dark','ArrowRight'),true);assert.equal(b.attributes.has('data-theme'),false);
  b.key('system','End');assert.equal(b.buttons[2].attributes.get('aria-checked'),'true');
  b.key('dark','Home');assert.equal(b.buttons[0].attributes.get('aria-checked'),'true');
  assert.equal(b.key('system','a'),false);
  b.searchShortcut();assert.equal(b.search.focused,true);assert.equal(b.navigation.checked,true);
});

test('system mode never sets a theme attribute, and corrupt or blocked storage falls back to it', () => {
  for (const saved of [null, 'system', 'invalid', '<script>']) {
    const b = browser(saved); b.mount();
    assert.equal(b.attributes.has('data-theme'), false);
    assert.equal(b.buttons[0].attributes.get('aria-checked'), 'true');
  }
  const b = browser('light', true); b.mount();
  assert.equal(b.attributes.has('data-theme'), false);
  b.click('dark'); assert.equal(b.attributes.get('data-theme'), 'dark');
  b.click('system'); assert.equal(b.attributes.has('data-theme'), false);
});

test('selection persists, resetting to system removes the override, and other tabs update the controls', () => {
  const b = browser(); b.mount();
  b.click('light'); assert.equal(b.attributes.get('data-theme'), 'light'); assert.equal(b.stored.get('circle-hub-theme'), 'light');
  b.click('dark'); assert.equal(b.attributes.get('data-theme'), 'dark'); assert.equal(b.stored.get('circle-hub-theme'), 'dark');
  b.external('light'); assert.equal(b.attributes.get('data-theme'), 'light'); assert.equal(b.buttons[1].attributes.get('aria-checked'), 'true');
  b.external(null); assert.equal(b.attributes.has('data-theme'), false);
  b.click('light'); b.click('system'); assert.equal(b.stored.has('circle-hub-theme'), false); assert.equal(b.attributes.has('data-theme'), false);
  b.click('invalid'); b.irrelevantClick(); assert.equal(b.attributes.has('data-theme'), false);
  assert.equal(browser(b.stored.get('circle-hub-theme') ?? null).attributes.has('data-theme'), false);
});

test('anonymous, setup and signed-in pages render exactly the fixed CSP-allowed resources', () => {
  for (const user of [null, { name: '合成成员', role: '成员', admin: false }]) for (const wide of [false, true]) {
    const body = page({ title: '合成页面', user, csrf: null, wide }, html`<p>${'<script>stored text</script>'}</p>`).text;
    assert.ok(body.indexOf('<script data-console-theme>') < body.indexOf('<style>'), 'restore before paint');
    const scripts = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0][1], THEME_SCRIPT);
    assert.equal(createHash('sha256').update(scripts[0][1]).digest('base64'), THEME_SCRIPT_HASH);
    const allowed = CONTENT_SECURITY_POLICY.split('; ').find((part) => part.startsWith('script-src '))!;
    assert.ok(allowed.includes(`'sha256-${THEME_SCRIPT_HASH}'`));
    const style = /<style>([\s\S]*?)<\/style>/.exec(body)![1];
    assert.equal(style, CSS);
    assert.ok(CONTENT_SECURITY_POLICY.includes(`style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'`));
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe|\*|https?:/);
    assert.doesNotMatch(body, /\sstyle=|\sonclick=|<script>stored text/);
    assert.match(body, /<noscript><span class="ch-meta">主题跟随系统<\/span><\/noscript>/);
    assert.match(body, /data-theme-switch hidden role="radiogroup" aria-label="主题"/);
    assert.doesNotMatch(body, /(?:共享给我的|未核验|已核验|暂无数据|等待你|交给你)/);
    const document = parse(body);
    const walk = (node: typeof document | (typeof document.childNodes)[number]): void => {
      if ('tagName' in node && node.tagName === 'button' && node.attrs.some((attr) => attr.name === 'data-theme-choice')) {
        assert.ok(node.attrs.some((attr) => attr.name === 'type' && attr.value === 'button'), 'theme never submits a form');
      }
      if ('childNodes' in node) node.childNodes.forEach(walk);
    };
    walk(document);
  }
});

test('fonts remain local, the orbit uses shared brand tokens, and favicon bytes stay unchanged', () => {
  const faces = CSS.match(/@font-face\s*\{[^}]+\}/g)!;
  assert.equal(faces.length, 3);
  for (const face of faces) {
    assert.match(face, /size-adjust: 92%/);
    assert.match(face, /src: local\(/);
    assert.doesNotMatch(face, /url\(/);
  }
  assert.match(CSS, /font-synthesis:none|font-synthesis: none/);
  for (const [i, color] of ['blue', 'violet', 'red', 'orange'].entries()) assert.ok(CSS.includes(`.ch-hubmark .s${i + 1} { fill: var(--brand-${color}); }`));
  assert.match(CSS, /--area: var\(--text-secondary\)/);
  assert.doesNotMatch(readFileSync(new URL('./style.ts', import.meta.url), 'utf8'), /#[\da-f]{6}\b|prefers-color-scheme/);
  assert.equal(createHash('sha256').update(FAVICON_SVG).digest('hex'), 'd3bc8f8ba78cbaee47786d2344735e72848f3d7b2dcd7dbd511778e57ff6b76f');
});
