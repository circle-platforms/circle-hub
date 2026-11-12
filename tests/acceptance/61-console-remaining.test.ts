// What was left of the console review issues after the reorganization (issues 212, 213, 217, 219, 220, 234, 238): one
// place that says where a reader is in the knowledge base, a source chosen by name, the publish choice, what each product
// source imports, and empty states and input hints that name their object. Real loopback Hub, synthetic content only.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { wordingProblems } from '../../hub/server/console/testing-wording.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let admin: ConsoleClient;
let member: ConsoleClient;

const csrf = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';
const context = (body: string) => /<p class="ch-meta" data-knowledge-context>([^<]*)<\/p>/.exec(body)?.[1] ?? '';

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: false });
  admin = await openConsole(bed.hub, bed.hub.admin.token);
  member = await openConsole(bed.hub, bed.reviewer.token);
});

after(async () => {
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('the knowledge base says where the reader is, at the same place on every view (issue 212)', () => {
  it('names the range and the kind of content on the home, the memories and the originals, and the folder inside one', async () => {
    const spaces = bed.hub.hub.knowledge.spaces!;
    await spaces.ensure(bed.reviewer.principal, bed.reviewer.user.id);
    await spaces.write(bed.reviewer.principal, { path: '/方法/步骤', kind: 'observation', statement: '合成条目：上下文要说全' });
    const home = await member.get('/console/knowledge?scope=personal');
    assert.equal(home.status, 200);
    assert.equal(context(home.body), '范围：我的 · 内容：知识');
    assert.equal(context((await member.get('/console/knowledge?scope=team')).body), '范围：团队 · 内容：知识');
    assert.equal(context((await member.get('/console/knowledge?view=memory&scope=personal')).body), '范围：我的 · 内容：记忆');
    assert.equal(context((await member.get('/console/knowledge?view=sources&scope=personal')).body), '范围：我的 · 内容：原文');
    const folder = await member.get('/console/knowledge/space?' + new URLSearchParams({ space: bed.reviewer.user.id, path: '/方法/步骤', scope: 'personal' }));
    assert.equal(context(folder.body), '范围：我的 · 内容：知识 · 位置：方法 › 步骤');
    // One line a reader can open says what the three kinds are; it is closed until asked for, and only on the home.
    assert.match(home.body, /<details class="ch-section" data-knowledge-guide><summary>知识、记忆和原文有什么不同<\/summary><p class="ch-meta">知识是带来源的陈述，可以分享到团队，供任务引用。记忆是客户端会话用的偏好和习惯，不作为任务的来源。原文是上传或读取到的原始文件，供知识逐字引用。左侧选的是谁的内容：我的、与我共享、团队。<\/p><\/details>/);
    assert.doesNotMatch(folder.body, /data-knowledge-guide/);
    assert.deepEqual(wordingProblems(home.body), []);
  });
});

describe('a source is chosen by the name of an original, and an empty list names its folder (issues 213, 217)', () => {
  it('offers the folder\'s originals for the first source, saves a picked one, and lets a typed reference win', async () => {
    const spaces = bed.hub.hub.knowledge.spaces!, owner = bed.reviewer;
    const place = { space: owner.user.id, path: '/来源', scope: 'personal' };
    // Before any original is in the folder: its empty state names the folder, and there is nothing to pick from.
    await spaces.write(owner.principal, { path: '/来源', kind: 'observation', statement: '合成条目：占一个文件夹' });
    const empty = await member.get('/console/knowledge/space?' + new URLSearchParams(place));
    assert.match(empty.body, /来源 中还没有原文/);
    assert.doesNotMatch(empty.body, /这个文件夹还没有原文/);
    assert.doesNotMatch((await member.get('/console/knowledge/space?' + new URLSearchParams({ ...place, edit: '1' }))).body, /name="source_pick_0"/);
    const quoted = '合成原文里可以逐字引用的一句话';
    const source = await spaces.importFile(owner.principal, Buffer.from(`第一行\n${quoted}\n第三行`), 'text/plain', '合成说明.txt', '/来源');
    const editor = await member.get('/console/knowledge/space?' + new URLSearchParams({ ...place, edit: '1' }));
    assert.equal(editor.status, 200);
    // The statement comes first, then the first source by name; JSON and further sources stay folded away.
    const picker = /<select name="source_pick_0">(.*?)<\/select>/s.exec(editor.body)?.[1] ?? '';
    assert.match(picker, new RegExp(`<option value="">不从原文中选</option><option value="src:${source.body.sha256}">合成说明\\.txt</option>`));
    assert.ok(editor.body.indexOf('name="statement"') < editor.body.indexOf('name="source_pick_0"'));
    assert.ok(editor.body.indexOf('name="source_pick_0"') < editor.body.indexOf('name="ground_0"'));
    assert.match(editor.body, /<details data-editor-advanced data-wide-field><summary>结构化数据与适用条件<\/summary>/);
    assert.match(editor.body, /<details data-editor-sources data-wide-field><summary>更多来源与逐字引文<\/summary>/);
    const fields = { csrf: csrf(editor.body), space: owner.user.id, path: '/来源', kind: 'observation', statement: '合成条目：来源按名字选', data: '', applicability: '', reason: '我的条目写入', source_pick_0: `src:${source.body.sha256}`, ground_0: '', quotation_0: quoted };
    const saved = await member.post('/console/knowledge/do/entry', fields);
    assert.ok(saved.status === 303 || saved.status === 200, `${saved.status} ${saved.body.slice(0, 300)}`);
    const version = (await spaces.visible(owner.principal, 'personal')).find((row) => row.space === owner.user.id)!.version;
    const row = version.body.entries.find((entry) => entry.path === '/来源' && entry.status === 'verified');
    assert.ok(row, 'the entry was saved and its quotation verified against the picked original');
    const entry = await spaces.entry(owner.principal, version.root, '/来源', row.entry);
    assert.deepEqual(entry!.body.grounds.map((ground) => [ground.reference, ground.quotation]), [[`src:${source.body.sha256}`, quoted]]);
    // A reference typed in the field wins over the pick: here it does not resolve, so the save is refused and says so.
    const typed = await member.post('/console/knowledge/do/entry', { ...fields, csrf: csrf((await member.get('/console/knowledge/space?' + new URLSearchParams({ ...place, edit: '1' }))).body), statement: '合成条目：填写的引用优先', ground_0: `src:${'0'.repeat(64)}` });
    assert.equal(typed.status, 400);
    // The refused form comes back with what was typed, and the fields keep the wording of the editor (issue 234).
    assert.match(typed.body, new RegExp(`name="ground_0" value="src:${'0'.repeat(64)}"`));
    assert.match(typed.body, /结构化数据（可选 JSON）/);
  });

  it('says what is wrong with a JSON field in the field\'s own terms when a save is refused (issue 234)', async () => {
    const owner = bed.reviewer;
    const editor = await member.get('/console/knowledge/space?' + new URLSearchParams({ space: owner.user.id, path: '/来源', scope: 'personal', edit: '1' }));
    const refused = await member.post('/console/knowledge/do/entry', { csrf: csrf(editor.body), space: owner.user.id, path: '/来源', kind: 'observation', statement: '合成条目：数据不是 JSON', data: '不是 JSON', applicability: '', reason: '我的条目写入', ground_0: '', quotation_0: '' });
    assert.equal(refused.status, 400);
    assert.match(refused.body, /结构化数据的格式不正确/);
    assert.match(refused.body, /请按下面标出的字段旁的说明修改后重新保存。/);
    assert.match(refused.body, /<span class="ch-field-error" id="editor-data-error" data-field-error>这里填的不是 JSON 对象。写成 \{&quot;字段&quot;:&quot;值&quot;\} 这样；不需要时留空。<\/span>/);
    assert.match(refused.body, /name="data"[^>]*aria-invalid="true"/);
    assert.doesNotMatch(refused.body, /请核对 JSON 格式和必填字段后重新保存/);
    // The memory editor names its body the same way wherever it is shown.
    const memory = await member.get('/console/knowledge?view=memory&scope=personal&edit=1');
    if (memory.body.includes('name="markdown"')) assert.match(memory.body, /正文（可使用 Markdown 文本）/);
  });
});

describe('the administrator\'s entries say what they are for (issues 219, 220, 238)', () => {
  it('marks the publish entry the page is on among the purposes', async () => {
    for (const [kind, text] of [['workflow', '完成有验收要求的任务'], ['skill', '提供通用做法'], ['system', '接入业务系统'], ['product', '提供产品知识来源']] as const) {
      const page = await admin.get('/console/operations/pack?kind=' + kind);
      assert.equal(page.status, 200, kind);
      const nav = /<nav class="ch-seg" aria-label="发布用途">(.*?)<\/nav>/s.exec(page.body)?.[1] ?? '';
      const current = [...nav.matchAll(/<a href="[^"]*kind=([a-z]+)"( aria-current="page")?>([^<]+)<\/a>/g)].filter((link) => link[2] !== undefined).map((link) => [link[1], link[3]]);
      assert.deepEqual(current, [[kind, text]], kind);
    }
  });

  it('lists what each enabled product source imports, by the titles its own pack declares, and keeps no planned card', async () => {
    const page = await admin.get('/console/operations/knowledge');
    assert.equal(page.status, 200);
    const materials = /<div data-product-materials>(.*?)<\/div><\/div>/s.exec(page.body)?.[0] ?? '';
    assert.match(materials, /各产品来源导入的内容，由产品包自己声明：/);
    // Every row is a product that can be chosen in the form, with at least one thing its producers import.
    const rows = [...materials.matchAll(/<tr[^>]*><td><b>([^<]+)<\/b> <code>([^<]+)<\/code><\/td><td><ul class="ch-plain-list">((?:<li>[^<]+<\/li>)+)<\/ul><\/td><\/tr>/g)];
    assert.ok(rows.length > 0, materials.slice(0, 400));
    const offered = [...(/<datalist id="products">(.*?)<\/datalist>/s.exec(page.body)?.[1] ?? '').matchAll(/<option value="([^"]+)">/g)].map((option) => option[1]);
    assert.deepEqual(rows.map((row) => row[2]).sort(), [...offered].sort());
    // The general card assumes no kind of material; a planned module no longer takes a card of its own.
    assert.doesNotMatch(page.body, /例如构建、手册、命令树|规划中|上传文档导入/);
    assert.deepEqual(wordingProblems(page.body), []);
  });
});
