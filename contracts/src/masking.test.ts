// The masking dictionary's pure part (B02 R[11], decision 159): what a rule may be, what a match becomes, and which
// content it applies to. Synthetic values only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASKING_DICTIONARY_SCHEMA, MaskingDictionary, MaskingRuleError, checkMaskingRule, compileMasking, isMaskableMediaType, maskPlaceholder } from './masking.ts';

const rule = (name: string, label: string, pattern: string, ignore_case = false) => ({ name, label, pattern, ignore_case });
const dictionary = (...rules: ReturnType<typeof rule>[]) => MaskingDictionary.parse({ schema: MASKING_DICTIONARY_SCHEMA, rules });

test('a match becomes a placeholder that says what was there and carries no part of the value', () => {
  const masking = compileMasking(dictionary(rule('device-password', '密码', 'synthetic-pass-[0-9]+')));
  const masked = masking.apply('登录 192.0.2.10，口令 synthetic-pass-20261112，再登录 synthetic-pass-7。');
  assert.equal(masked.text, '登录 192.0.2.10，口令 [密码已遮盖 *****]，再登录 [密码已遮盖 *****]。');
  assert.deepEqual(masked.applied, [{ rule: 'device-password', count: 2 }]);
  assert.equal(maskPlaceholder('密钥'), '[密钥已遮盖 *****]');
  // Text without a match is returned as it was, the same string, and says that nothing was applied.
  const plain = '这段合成文字里没有口令';
  const untouched = masking.apply(plain);
  assert.equal(untouched.text, plain); assert.deepEqual(untouched.applied, []);
  assert.deepEqual(compileMasking(null).apply(plain), { text: plain, applied: [] });
});

test('a pattern with a group named secret replaces that group only, so the words around the value stay', () => {
  const masking = compileMasking(dictionary(rule('assigned', '密码', 'password\\s*[:=]\\s*(?<secret>[^\\s,"]+)', true)));
  assert.equal(masking.apply('{"note":"Password = synthetic-value-1, 重试"}').text, '{"note":"Password = [密码已遮盖 *****], 重试"}');
  // The result of a JSON answer is still JSON: the placeholder holds no quote and no backslash.
  assert.deepEqual(JSON.parse(masking.apply('{"a":"password: synthetic-value-2"}').text), { a: 'password: [密码已遮盖 *****]' });
});

test('every rule reads the text as it was read: no rule matches another rule\'s placeholder, and the earlier match stands', () => {
  const masking = compileMasking(dictionary(
    rule('key', '密钥', 'sk-[a-z0-9]{8}'),
    // A rule that would match a placeholder, were it applied to the replaced text.
    rule('bracketed', '标记', '\\[[^\\]]+\\]'),
    rule('long', '密码', 'sk-[a-z0-9]{8}-tail'),
  ));
  const masked = masking.apply('a sk-abcd1234-tail b [原有标记] c');
  // key and long start together: the rule earlier in the dictionary stands, and long's overlapping match is dropped.
  assert.equal(masked.text, 'a [密钥已遮盖 *****]-tail b [标记已遮盖 *****] c');
  assert.deepEqual(masked.applied, [{ rule: 'key', count: 1 }, { rule: 'bracketed', count: 1 }]);
});

test('a rule is checked when it is set: names, labels, patterns that do not compile, match nothing or run away', () => {
  assert.deepEqual(checkMaskingRule(rule('ok-rule', ' 设备口令 ', 'abc+')), { name: 'ok-rule', label: '设备口令', pattern: 'abc+', ignore_case: false });
  for (const [bad, message] of [
    [rule('Bad', '密码', 'a'), /规则名/],
    [rule('quote', '密"码', 'a'), /标签不能含/],
    [rule('bracket', '[密码]', 'a'), /标签不能含/],
    [rule('star', '密码*', 'a'), /标签不能含/],
    [rule('empty-label', '   ', 'a'), /标签不能为空/],
    [rule('broken', '密码', '(unclosed'), /不是合法的正则表达式/],
    [rule('empty-match', '密码', 'a*'), /能匹配空文本/],
    [rule('too-long', '密码', 'a'.repeat(501)), /至多 500 个字符/],
    [{ ...rule('extra', '密码', 'a'), flags: 'g' }, /./],
  ] as const) assert.throws(() => checkMaskingRule(bad), (error) => error instanceof MaskingRuleError && message.test(error.message), JSON.stringify(bad));
  // A pattern slow on a long run is refused; the clock is the caller's, so the check itself is deterministic here.
  let tick = 0;
  assert.throws(() => checkMaskingRule(rule('slow', '密码', 'abc+'), () => (tick += 100)), /过慢/);
  // With the real clock: patterns that backtrack exponentially are caught on a short run, long before a long one is tried.
  for (const pattern of ['(a+)+$', '(a|a)+$', '(\\w+\\s?)+$', '([a-z]+)*=']) {
    const started = performance.now();
    assert.throws(() => checkMaskingRule(rule('runaway', '密码', pattern)), /过慢/, pattern);
    assert.ok(performance.now() - started < 5000, `${pattern} was refused in ${Math.round(performance.now() - started)} ms`);
  }
  // Ordinary patterns pass, the kind an administrator writes for a password or a key.
  for (const pattern of ['password\\s*[:=]\\s*(?<secret>\\S+)', 'sk-[A-Za-z0-9]{20,}', '(?<=enable secret )\\S+', 'AKIA[0-9A-Z]{16}']) checkMaskingRule(rule('fine', '密码', pattern));
});

test('a dictionary holds each name once and at most 64 rules', () => {
  assert.equal(MaskingDictionary.safeParse({ schema: MASKING_DICTIONARY_SCHEMA, rules: [rule('a', '密码', 'x'), rule('a', '密钥', 'y')] }).success, false);
  assert.equal(MaskingDictionary.safeParse({ schema: MASKING_DICTIONARY_SCHEMA, rules: Array.from({ length: 65 }, (_, n) => rule(`r${n}`, '密码', 'x')) }).success, false);
  assert.equal(MaskingDictionary.safeParse({ schema: 'masking-dictionary@2', rules: [] }).success, false);
});

test('the dictionary applies to text of any format and leaves other bytes alone', () => {
  for (const type of ['text/plain', 'text/html; charset=gbk', 'application/json', 'application/problem+json', 'application/xml', 'image/svg+xml', 'text/csv', 'application/x-ndjson']) assert.equal(isMaskableMediaType(type), true, type);
  for (const type of ['application/octet-stream', 'application/zip', 'image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel']) assert.equal(isMaskableMediaType(type), false, type);
});
