# 任务：稳定大体积 base64 扫描测试数据

来源：集成者 2026-10-28 的任务指令；完整 macOS 验收报告 `hub/records/scan.test.ts` 的随机 base64 输入在 clean 断言失败。随机文本可能偶合扫描器接受的凭据形状，因此“随机生成”不构成“无命中”的保证。

分支：`stable-scan-fixture`，从 `hub-redesign` 的 `98ae86c6` 开出。

## 可改路径

- `hub/records/scan.test.ts`
- `hub/records/README.md`
- `docs/hub-r4-tasks/stable-scan-fixture.md`

## 改动与限制

只将原性能测试的大图片字节换成固定公开种子的 SHAKE256 输出，仍为 1,500,000 字节，不过滤或重写扫描命中，保留原 clean、上限和耗时断言；另加字节数和 gzip 后大小大于原始 99% 的断言，防止退化成可压缩的重复数据。

新增正例在同规模字节的三字节对齐位置放入 33 个合成字节，使编码后的 base64 恰好包含带边界的凭据形状。形状运行时拼装；断言编码后的精确位置及扫描器仍给出 cloud_key 命中、已检查且不 clean。生产扫描器不改。

## 验证状态

按集成者指令，当前 macOS 全量验收占用期间不运行测试或类型检查。本任务尚未建立固定种子输入实际 clean 或所有断言通过的运行证据。

待集成者运行 `node --test hub/records/scan.test.ts`、`npx tsc --noEmit`，并纳入 macOS 全量验收。没有跳过、删除或放宽原断言。
