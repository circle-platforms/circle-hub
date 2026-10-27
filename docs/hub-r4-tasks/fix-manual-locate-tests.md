# 任务：按需取片段合入后 packs 里两项测试变红

依据：`docs/hub-r4-tasks/skill-lazy-locate.md`（cursor，提交 3967a04d）。

## 现象

主干（含 `0b8c486f`）上 `node --test packs/product/apv/functions/manual.test.ts` 有 2 项失败（agy 跑 `packs/**` 报的 4 项是这 2 项加它们的父套件）：

- `gives fragments the markdown@1 document locates, with the same text`（约 228 行）：3967a04d 把 `md.locate` 改成 `await` 时，把 `.map((fragment) => …)` 改成了 `.map(async (fragment) => …)`，但没有 `await Promise.all(...)`，后面的 `.join('\n')` 把一组 Promise 拼成 `[object Promise]`，断言比较的是 Promise 不是文本；
- `preserves every source fragment across trees while only verified commands become definitions`（约 933 行附近）：同类的 `map(async …)` 未等待。

这两项在 `3967a04d` 之前是通过的（主干 `23fd8598` 的全量检查里通过）。合入前没有跑 `packs/**`，当时的全量只覆盖到 hub、contracts、docs、验收。

## 要做的

1. 修这两处：`await Promise.all(...)` 之后再 `.join`，断言原样保留（不放松，不删，不改期望值）。
2. 用 `git grep -n "map(async"` 和 `git grep -n "\.locate("` 在 `packs/**`、`hub/**`、`tests/**`、`tools/**` 里查有没有别的"改成 async 但没等待"的同类写法（不只是测试，生产代码也查）；有就一并修，并各说明。
3. 跑全量并报数：`npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/**/*.test.ts"`（必须是全部，不是只跑 product）；`node --test --test-concurrency=2 "hub/**/*.test.ts" "contracts/**/*.test.ts" ".github/checks/*.test.ts"`。

## 分支、路径和规矩

- 分支和工作树：`fix-manual-locate-tests`，目录 `cursor-trees/fix-manual-locate-tests`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：`packs/product/apv/functions/manual.test.ts`，以及第 2 步查到的同类写法所在文件（先在回报里列出）。别的路径要改先说明。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和真实系统；测试只用合成数据；`git commit -s`，只暂存明确路径；提交说明一句英文祈使句，无前缀无句号）。已发布包的文件不要动（动了要升版本重签）。

完成后在终端里回报：提交号、改了哪几处、第 2 步查到的其他位置、各组测试数量。
