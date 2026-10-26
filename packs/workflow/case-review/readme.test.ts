import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('the closure record reports the resolved K2 scan instead of an obsolete merge blocker', () => {
  const text = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(text, /02a0066e.*6 处.*已修复/);
  assert.doesNotMatch(text, /当前以下 K2 文件尚未修改|本项不能合并|K2 的既有 6 处命中仍等待|也未改 K2 文件/);
  assert.match(text, /全仓扫描.*通过/);
});
