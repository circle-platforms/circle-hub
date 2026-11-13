import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  count,
  errorLine,
  figure,
  filterForm,
  nextPage,
  postForm,
  segments,
  selectControl,
  submitButton,
} from './components.ts';
import { emptyBlock } from './html.ts';
import { skillPath, skillsPath, workflowPath, workflowsPath } from './routes.ts';

test('postForm carries csrf and optional personal epoch', () => {
  const text = postForm({
    action: '/console/admin/do/token-create',
    csrf: 'tok',
    fields: '<input name="name" value="x">',
    submit: '创建',
    personalEpoch: 'epoch-1',
  }).text;
  assert.match(text, /method="post"/);
  assert.match(text, /name="csrf" value="tok"/);
  assert.match(text, /name="personal_epoch" value="epoch-1"/);
  assert.match(text, /ch-btn--primary/);
});

test('filterForm is a GET form marked data-filters', () => {
  const text = filterForm('/console/runs', '<label>工作流</label>', '筛选').text;
  assert.match(text, /data-filters/);
  assert.match(text, /method="get"/);
  assert.match(text, /action="\/console\/runs"/);
  assert.match(text, />筛选</);
});

test('nextPage links with encoded query params', () => {
  const text = nextPage('/console/runs', { cursor: 'abc', pack: null }).text;
  assert.match(text, /下一页/);
  assert.match(text, /href="\/console\/runs\?cursor=abc"/);
});

test('segments marks the current tab and formats counts', () => {
  const text = segments('任务内容', [
    { href: '/console/runs', label: '任务', count: 1200, current: true },
    { href: '/console/runs?view=requests', label: '请求', count: 3 },
  ], 'data-task-tabs').text;
  assert.match(text, /class="ch-seg"/);
  assert.match(text, /data-task-tabs/);
  assert.match(text, /aria-current="page"/);
  assert.match(text, /1,200/);
});

test('emptyBlock, errorLine, submitButton and selectControl render once', () => {
  assert.match(emptyBlock({ title: '尚无任务', text: '客户端启动任务后在此列出。' }).text, /ch-empty-title/);
  assert.match(errorLine('筛选的任务结果不对').text, /class="error"/);
  assert.match(submitButton('保存', { danger: true }).text, /ch-btn--danger/);
  const select = selectControl('pack', [{ value: 'w1', label: '工作流一', selected: true }], { value: '', label: '全部' }).text;
  assert.match(select, /<select name="pack">/);
  assert.match(select, /selected/);
  const required = selectControl('audience', [{ value: 'none', label: '先不分配' }], undefined, { required: true }).text;
  assert.match(required, /<select name="audience" required>/);
  const disabled = selectControl('team', [{ value: '', label: '尚无团队' }], undefined, { disabled: true }).text;
  assert.match(disabled, /<select name="team" disabled>/);
});

test('figure formats numbers through count', () => {
  assert.equal(count(1200), '1,200');
  assert.match(figure('可读产品线', 1200).text, /1,200/);
  assert.match(figure('延迟', '12 毫秒', { unit: 'p95', note: '近一批' }).text, /ch-stat-note/);
});

test('workflow and skill route constructors', () => {
  assert.equal(workflowsPath(), '/console/workflows');
  assert.equal(workflowPath('wf/1'), '/console/workflows/wf%2F1');
  assert.equal(skillsPath(), '/console/skills');
  assert.equal(skillPath('sk 1'), '/console/skills/sk%201');
});
