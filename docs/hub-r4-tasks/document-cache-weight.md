# 任务：文档缓存每次读取都重新遍历整份解析模型，大文档下拖慢整条管线

依据：公开快照 R6 的 CI 在解析器边界分区失败：`hub/refs/adversarial.test.ts` 的 `HTML: 200000 links in one block` 在 Linux 上用了 6.6 秒，上限是 6 秒（`PIPELINE_BOUND_MS`）。本机同一用例是 2.3 秒，R6 之前的公开代码是 1.35 秒。这条用例是复杂度上限的回归哨兵，**不改它的上限、不放松任何断言**，要修的是代码。

## 已量到的原因（集成者用 CPU 剖析定位）

`hub/refs/resolve.ts` 的 `createDocumentCache`：

- `get(key)` 每次都调 `trim()`，`trim()` 对缓存里**每一份**文档重新算 `weight(document)`；`set` 也算一次。
- `weight` 对有 `retainedBytes()` 的文档（沙箱里按需取片段的文档，缓存会随取片段增长）读它的数，开销很小；对没有 `retainedBytes()` 的"旧式"文档（进程内的核心解析器，以及单元测试里以进程内方式用的技能包解析器）调 `legacyDocumentBytes(document, limit)`，它**遍历整个解析模型对象图**。
- 20 万个链接的 HTML 模型约有一百万个对象：剖析里这个函数自身耗时 691 毫秒（整条管线总计 2.3 秒）；第一次 `resolveReference` 从约 600 毫秒涨到约 1100 毫秒，第二、第三次从 1 毫秒涨到约 140 毫秒。生产里的 json、text、markdown 等核心解析器也是旧式文档，缓存里每多一次 `get` 就整份重走一遍，是同一个问题。

## 要做的

1. 旧式文档（没有 `retainedBytes`）的重量**在进入缓存时只量一次**，存在缓存行里，之后 `trim()`、淘汰、超预算判断都用存下的数；解析模型在解析后不会再变。
2. 有 `retainedBytes()` 的文档保持现状：每次读它的当前数（它会随缓存的片段增长，且订阅了 `onRetainedBytesChange`）。
3. 预算语义完全不变：单份超预算仍抛 `SANDBOX_OUTPUT_TOO_LARGE`（`document_cache_bytes`）并清空；条数上限、LRU 顺序、`dispose`、退订行为都不变；已有的 `document-cache-budget.test.ts` 全部保持通过且不改断言。
4. 新增回归测试（加在 `document-cache-budget.test.ts`，或同目录一个新文件）：造一份旧式文档，模型里放一个**带计数的 getter**（`Object.entries` 会触发它），连续做 `set` 加十几次 `get`/`load`，断言 getter 只被触发一次（也就是模型只被遍历了一次）；再断言单份超预算仍然抛错、淘汰仍按存下的重量进行。
5. 在回报里给出前后对比：用 `adversarial.test.ts` 里 `HTML: 200000 links in one block` 同样的输入，分别量 `resolveReference` 三次调用的耗时，以及整条用例的耗时（改前约 2.3 秒，改后应接近 1.4 秒）。

## 不动

`hub/refs/adversarial.test.ts` 的任何上限和断言；其他包；`contracts/**`。

## 分支、路径和规矩

- 分支和工作树：`document-cache-weight`，目录 `cursor-trees/document-cache-weight`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：`hub/refs/resolve.ts`、`hub/refs/document-cache-budget.test.ts`（以及同目录新增的一个测试文件，如需要）。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，只暂存明确的路径）。未知只能是过渡状态；不用关键词匹配做判断。
- 验证（终端必须跑**完整套**，不要只跑相关目录）：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2` 对 `hub/refs/**`、`hub/knowledge/**`、`hub/runs/**`、`hub/server/**`、`packs/skill/**`；`npm run test:docs`。报计数。

## 回报

在终端里回报：提交号、各项测试的数量与结果、前后耗时对比（三次 `resolveReference` 和整条用例）、没做完或拿不准的地方。集成者会另用公开快照里的同一用例再核。
