import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetNodesOutput } from '../../contracts/src/tools.ts';
import { TRACE } from '../../contracts/src/fixtures.ts';
import { toolText } from './text.ts';

const reference='src:'+'a'.repeat(64);
test('source text shows two access outcomes while preserving the detailed tier and withholding reason', () => {
  const contents=[
    {reference,read_tier:'model_readable',readable:true,text:'合成原文'},
    {reference,read_tier:'function_bytes_only',readable:false,structure:{summary:{count:1}},note:'只许函数按引用读字节'},
    {reference,read_tier:'retain_only',readable:false,note:'含凭据，原文不可读'},
  ] as const;
  const expected=['模型可读','原文不可读','原文不可读'];
  for (const [i,content] of contents.entries()) {
    const answer=GetNodesOutput.parse({call_result:'ok',errors:[],content,trace:TRACE});
    const before=JSON.stringify(answer);
    const text=toolText('get_nodes',answer,{paging:true});
    assert.ok(text.startsWith(`内容 ${reference}：${expected[i]}\n`));
    if ('note' in content) assert.ok(text.includes(content.note));
    if ('text' in content) assert.ok(text.includes(content.text));
    else assert.ok(!text.includes('合成原文'));
    assert.equal(answer.content?.read_tier,content.read_tier);
    assert.equal(JSON.stringify(answer),before,'rendering does not change structured answers or historical bytes');
  }
});

test('a source held back at retain_only names the administrator review as the next step; other tiers do not', () => {
  const step=/下一步：请管理员核看这份来源为何只保留；凭据误报经管理员接受后，用同一引用重读；含真凭据或按策略只保留的不会放行/;
  const held=[
    {reference,read_tier:'retain_only',readable:false,note:'含凭据，原文不可读'},
    {reference,read_tier:'retain_only',readable:false,note:'含凭据，原文不可读',structure:{summary:{count:1}}},
  ] as const;
  for (const content of held) {
    const text=toolText('get_nodes',GetNodesOutput.parse({call_result:'ok',errors:[],content,trace:TRACE}),{paging:true});
    assert.match(text,step);assert.ok(!/circle-hub /.test(text),'the caller text names no administrator command');
  }
  for (const content of [{reference,read_tier:'model_readable',readable:true,text:'合成原文'},{reference,read_tier:'function_bytes_only',readable:false,structure:{summary:{count:1}},note:'只许函数按引用读字节'}] as const)
    assert.doesNotMatch(toolText('get_nodes',GetNodesOutput.parse({call_result:'ok',errors:[],content,trace:TRACE}),{paging:true}),/下一步：请管理员核看/);
});
