import { test } from 'node:test';
import assert from 'node:assert/strict';
import check from './workbook.ts';
import { projectItems } from './project.ts';
import { CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC, MINDMAP_MODEL, AUTOID } from './test-support.ts';
test('missing workbook is a transitional missing-input result with the automatic client action', () => {
  const result = check({ subject: { item: 'fixture', workbook: null } })[0]; assert.equal(result.verdict, 'unknown'); assert.equal(result.reason, 'missing_input'); assert.match(result.statement, /缺少自动化用例 Excel。下一步由编写模型把自动化用例核对正确，生成并上传自动化用例 Excel，再继续脚本合并/); assert.match(result.statement, /不证明在真实设备上跑得通/);
});
test('a fabricated JSON workbook cannot bypass core xlsx binding', () => {
  const input = { inputs: [{ slot: 'subject', parser: 'kityminder@1', model: MINDMAP_MODEL }, { slot: 'contract', model: CONTRACT_DOC }, { slot: 'profile', model: PROFILE_DOC }, { slot: 'inventory', model: MANIFEST_DOC }] as unknown[], parameters: { autoid: AUTOID } }; input.inputs.push({ slot: 'workbook', parser: 'json@1', sha256: 'a'.repeat(64), model: {} });
  const result = projectItems(input) as { error: { code: string } }; assert.equal(result.error.code, 'case-compile.workbook_input');
});
