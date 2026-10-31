// An error is printed as a claim (D05 R[8]): after its statement the qualifier, grounds and rule, the missing fact and the
// open causes, the residual 其他 always last, then the fix; options say how many there are.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolError } from '../../contracts/src/common.ts';
import { errorLine } from './text.ts';

test('the claim fields follow the statement in a fixed order and the fix comes after them', () => {
  const line = errorLine(ProtocolError.parse({
    code: 'synthetic.no_fix_text',
    message: '缺陷 910002 没有可引用的修复说明',
    fix: '缺陷修复后再开运行（你的运行能做）',
    provenance: 'projected',
    collected_at: '2026-11-01T00:00:00.000Z',
    grounds: [`src:${'c'.repeat(64)}`],
    warrant: 'synthetic@1.0.0 functions/projection.ts',
    missing: '可以引用的修复说明',
    hypotheses: [
      { statement: '缺陷还没有修复', prediction: '没修复的缺陷不会声明 fixed', support: ['状态是 “active”'], status: 'open' },
      { statement: '修复说明写在没有配置读取的字段里', support: ['没有配置字段'], status: 'open' },
    ],
  }));
  const order = ['限定：投影，采集于 2026-11-01T00:00:00.000Z', `根据：src:${'c'.repeat(64)}`, '规则：synthetic@1.0.0 functions/projection.ts', '缺失事实：可以引用的修复说明', '原因未定，假设（3 个开放，未区分）：', '修正：缺陷修复后再开运行'];
  let at = 0;
  for (const part of order) {
    const found = line.indexOf(part, at);
    assert.ok(found >= at, `${part} after position ${at} in ${line}`);
    at = found + part.length;
  }
  assert.match(line, /1\. 缺陷还没有修复（开放；规则的预测：没修复的缺陷不会声明 fixed；支持：状态是 “active”）；2\. 修复说明写在没有配置读取的字段里（开放；支持：没有配置字段）；3\. 其他（开放：以上都不是）/);
});

test('an excluded hypothesis shows its refutation and is not counted among the open ones; 其他 stays', () => {
  const line = errorLine(ProtocolError.parse({
    code: 'synthetic.no_fix_text',
    message: '没有修复说明',
    hypotheses: [
      { statement: '缺陷还没有修复', refute: ['原始结构状态声明 fixed'], status: 'excluded' },
      { statement: '修复说明在别的字段里', status: 'open' },
    ],
  }));
  assert.match(line, /原因未定，假设（2 个开放，未区分）：1\. 缺陷还没有修复（已排除；反驳：原始结构状态声明 fixed）；2\. 修复说明在别的字段里（开放）；3\. 其他（开放：以上都不是）/);
});

test('options say their count: a complete list says so, a cut one says how many were left and where they are', () => {
  const complete = errorLine(ProtocolError.parse({ code: 'REFERENCE_UNRESOLVED', message: '没有这个名字', options: ['甲', '乙'], options_coverage: { complete: true, examined: 2, total: 2 } }));
  assert.match(complete, /可选（共 2 个，全部列出）：甲、乙/);
  const cut = errorLine(ProtocolError.parse({ code: 'REFERENCE_UNRESOLVED', message: '没有这个名字', options: ['甲'], options_coverage: { complete: false, examined: 1, total: 9, note: '其余的写 version 再看' } }));
  assert.match(cut, /可选（列出 1 个，共 9 个；其余的写 version 再看）：甲/);
  const bare = errorLine(ProtocolError.parse({ code: 'REFERENCE_UNRESOLVED', message: '没有这个名字', options: ['甲'] }));
  assert.match(bare, /；可选：甲$/);
});

test('an error without claim fields prints as before', () => {
  assert.equal(errorLine(ProtocolError.parse({ code: 'SUBMISSION_SCHEMA_VIOLATION', message: '缺字段', fix: '补上', path: '/a' })), '- SUBMISSION_SCHEMA_VIOLATION：缺字段；修正：补上；位置 /a');
});
