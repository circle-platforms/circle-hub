# 任务：test-bed 的标题改成"自动化测试环境"

依据：所有者 2026-10-31「改成自动化测试环境，检查过了就发布」。这是对集成者提问的答复：决定 110 机械替换后，test-bed 的标题从"设备台架"变成了"设备自动化测试环境"，读着绕，要不要改成"自动化测试环境"。

- 分支和工作树：`test-bed-title`，从 hub-redesign da68ee08c 开出。
- 改动：
  - test-bed 的标题改成"自动化测试环境"。描述、行为和英文标识都不变。
  - test-bed 从 1.2.10 升到 1.2.11：改 `pack-files.ts` 里的版本和标题、`pack.test.ts` 里断言的版本、README 标题里的版本号。
  - 用 `node tools/prepare-packs.ts packs/workflow/test-bed` 重新生成 `pack.json`。
- 可以改的路径：`packs/workflow/test-bed/pack-files.ts`、`packs/workflow/test-bed/pack.json`、`packs/workflow/test-bed/pack.test.ts`、`packs/workflow/test-bed/README.md`、`docs/hub-r4-progress.md`（记录结果）、本页。
- 规则：
  - 用合成数据，提交用 `git commit -s`。
  - 只发布 test-bed 1.2.11，Hub 不重新部署；所有者这次的答复就是发布许可（G3）。
- 验证：
  - `npx tsc --noEmit`、`npm run verify:contracts`、`npm run test:docs`；
  - test-bed 自己的测试，`packs/workflow/case-review/packs.test.ts`，`wf/affected-tests.py --run` 列出的受影响测试；
  - 发布后在生产上核对：分配不变，普通账号的任务包列表里显示 `test-bed@1.2.11 自动化测试环境`。
