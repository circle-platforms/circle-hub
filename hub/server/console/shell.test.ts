import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { html, href, liveModule, page, pageLayout, type NavKey } from './html.ts';
import { directoryTree } from './space-layout.ts';
import { button } from './ui.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const elements = (node: Node, tag?: string): Element[] => {
  const own = 'tagName' in node && (!tag || node.tagName === tag) ? [node] : [];
  return [...own, ...('childNodes' in node ? node.childNodes.flatMap((child) => elements(child, tag)) : [])];
};
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const has = (el: Element, cls: string) => (attr(el, 'class') ?? '').split(' ').includes(cls);
const text = (node: Node): string => 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
const member = { name: '合成成员', role: '成员', admin: false };
const bodyOf = (source: string) => elements(parse(source), 'body')[0];

test('all eight areas use one three-column shell, the ordered navigation and a footer theme selector', () => {
  const areas: NavKey[] = ['overview', 'tasks', 'knowledge', 'packs', 'connections', 'records', 'team', 'settings'];
  for (const active of areas) {
    const source = page({ title: '合成页面', active, user: member, csrf: 'synthetic-csrf', actions: html`${button('/secondary', '查看')}${button('/primary', '新建', { primary: true })}` }, pageLayout(html`<p>合成内容</p>`, { inspector: html`<h2 class="ch-panel-title">合成概况</h2><p>知识 3 条</p>` })).text;
    const body = bodyOf(source), all = elements(body);
    const shell = all.find((el) => has(el, 'ch-app'))!;
    assert.equal(elements(shell).filter((el) => has(el, 'ch-nav')).length, 1);
    assert.equal(elements(shell).filter((el) => has(el, 'ch-pane')).length, 1);
    assert.equal(elements(shell).filter((el) => has(el, 'ch-inspector')).length, 1);
    const nav = all.filter((el) => has(el, 'ch-nav-item'));
    assert.deepEqual(nav.map(text), ['总览', '任务', '知识库', '工作流', '连接', '记录', '团队', '设置']);
    assert.equal(nav.filter((el) => attr(el, 'aria-current') === 'page').length, 1);
    assert.equal(nav[areas.indexOf(active)].attrs.some((a) => a.name === 'aria-current'), true);
    assert.equal((attr(shell, 'class') ?? '').includes('area-knowledge'), active === 'knowledge');
    assert.equal((attr(shell, 'class') ?? '').includes('area-workflow'), active === 'packs');
    assert.equal((attr(shell, 'class') ?? '').includes('area-task'), active === 'tasks');
    const foot = all.find((el) => has(el, 'ch-nav-foot'))!;
    assert.match(text(foot), /合成成员.*成员/s);
    const control = elements(foot).find((el) => attr(el, 'data-theme-switch') !== undefined)!;
    assert.ok(has(control, 'ch-seg'));
    assert.equal(attr(control, 'role'), 'radiogroup');
    assert.equal(elements(foot, 'button').filter((el) => attr(el, 'role') === 'radio').length, 3);
    const header = all.find((el) => has(el, 'ch-page-head'))!;
    assert.ok(!elements(header).some((el) => attr(el, 'data-theme-switch') !== undefined));
    const actions = elements(header).filter((el) => has(el, 'ch-btn'));
    assert.equal(actions.length, 2); assert.ok(has(actions.at(-1)!, 'ch-btn--primary'));
    assert.equal(elements(foot, 'form')[0].attrs.find((a) => a.name === 'action')?.value, '/console/logout');
    assert.doesNotMatch(source, /class="(?:shell|side|top|login-card)"/);
  }
});

test('运行状况 is the ninth place, listed for administrators only', () => {
  const admin = { name: '合成管理员', role: '管理员', admin: true };
  const nav = (user: typeof admin, active: NavKey) => elements(bodyOf(page({ title: '合成页面', active, user, csrf: 'synthetic-csrf' }, html`<p>合成内容</p>`).text)).filter((el) => has(el, 'ch-nav-item'));
  const places = nav(admin, 'health');
  assert.deepEqual(places.map(text), ['总览', '任务', '知识库', '工作流', '连接', '记录', '团队', '设置', '运行状况']);
  assert.equal(attr(places[8], 'href'), '/console/health');
  assert.equal(attr(places[8], 'aria-current'), 'page');
  assert.ok(!nav(member, 'settings').map(text).includes('运行状况'));
});

test('pre-sign-in pages are single panels without navigation, account content or layout slots', () => {
  for (const title of ['登录', '修改密码', '创建首位管理员', '登录链接已失效', '授权请求已失效']) {
    const source = page({ title, user: null, csrf: null, wide: true }, pageLayout(html`<form><div class="ch-field"><label class="ch-field-label" for="synthetic-input">合成字段</label><div class="ch-input"><input id="synthetic-input"></div></div></form>`, { sidebar: html`PRIVATE_NAVIGATION`, inspector: html`PRIVATE_INSPECTOR`, detail: true })).text;
    const all = elements(bodyOf(source));
    const panel = all.find((el) => attr(el, 'data-sign-in') !== undefined)!;
    assert.ok(panel); assert.ok(!all.some((el) => has(el, 'ch-app') || has(el, 'ch-nav') || has(el, 'ch-inspector')));
    assert.doesNotMatch(text(bodyOf(source)), /PRIVATE_NAVIGATION|PRIVATE_INSPECTOR|合成成员/);
    assert.ok(!all.some((el) => attr(el, 'id') === 'console-search'));
    const foot = elements(panel, 'footer')[0];
    assert.ok(elements(foot).some((el) => has(el, 'ch-seg')));
    const header = elements(panel).find((el) => has(el, 'ch-page-head'))!;
    assert.ok(!elements(header).some((el) => attr(el, 'data-theme-switch') !== undefined));
  }
});

test('layout slots keep authorized navigation inside the active area and preserve explicit detail and return URLs', () => {
  const back = href('/console/knowledge', { scope: 'personal', q: '合成筛选', page: 2 });
  const content = pageLayout(html`<p>合成列表</p>`, { sidebar: html`<div class="ch-nav-sub">合成已授权文件夹</div>`, inspector: liveModule('synthetic-detail',['task.updated'],html`<h2 class="ch-panel-title">合成选中对象</h2>`), detail: true, back: html`<a href="${back}">返回列表</a>` });
  const source = page({ title: '合成页面', active: 'knowledge', user: member, csrf: null, sub: '12 条知识', hint: '合成用法提示' }, content).text;
  const all = elements(bodyOf(source));
  assert.ok(all.some((el) => has(el, 'ch-app') && has(el, 'is-detail')));
  const nav = all.find((el) => has(el, 'ch-nav'))!;
  assert.match(text(nav), /知识库合成已授权文件夹工作流/);
  const main = all.find((el) => has(el, 'ch-pane'))!;
  const inspector = all.find((el) => has(el, 'ch-inspector'))!;
  assert.match(text(main), /合成列表/); assert.doesNotMatch(text(main), /合成已授权文件夹|合成选中对象/);
  assert.match(text(inspector), /合成选中对象/);
  assert.ok(elements(inspector).some((el)=>attr(el,'id')==='live-state'),'live status stays in the visible detail pane');
  assert.ok(elements(parse(source),'script').some((el)=>attr(el,'type')==='module'),'an inspector-only live module still receives updates');
  assert.equal(attr(elements(inspector, 'a')[0], 'href'), back);
  const hint = all.find((el) => attr(el, 'id') === 'page-hint')!;
  assert.equal(attr(hint, 'role'), 'tooltip');
  assert.ok(all.some((el) => attr(el, 'aria-describedby') === 'page-hint' && attr(el, 'title') === '合成用法提示'));
});

test('folder navigation stops at three levels without hiding the link that opens deeper folders', () => {
  const tree = directoryTree(['/a', '/a/b', '/a/b/c', '/a/b/c/d'], (path) => '/console/knowledge/space?' + new URLSearchParams({ path }), '/', undefined, 3, '/a/b/c');
  const anchors = elements(parse(tree.text), 'a');
  assert.deepEqual(anchors.map(text), ['a', 'b', 'c']);
  assert.match(attr(anchors[2], 'href')!, /path=%2Fa%2Fb%2Fc/);
  assert.equal(attr(anchors[2], 'aria-current'), 'page');
});


test('areas without a meaningful overview omit the inspector and all placeholder account facts', () => {
  const source=page({title:'合成区域',active:'records',user:member,csrf:null},html`合成记录`).text;
  const all=elements(bodyOf(source));
  assert.ok(all.some(el=>attr(el,'data-without-inspector')!==undefined));
  assert.ok(!all.some(el=>has(el,'ch-inspector')));
  assert.doesNotMatch(source,/当前页面|当前账号/);
});
