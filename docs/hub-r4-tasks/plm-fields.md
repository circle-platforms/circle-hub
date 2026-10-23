# 任务：PLM 系统包回传修复说明字段，并按名字读构建列表

依据：

- d2c-pack-fixes 的交接（缺陷转用例 1.6.0，`packs/workflow/defect-to-case/README.md` 103–109 行，在那条分支上）：
  - 引文只许取自缺陷记录里修复说明那个字段；
  - 字段名是部署事实，放在 PLM 资源设置 `settings.bug_fix_field` 里；
  - 包读缺陷内容里的 `fix_field`，PLM 系统包还没回传，所以真实启动会拒绝。
- `plan-evidence.md` 第 4 条（PLM 系统包按名字读构建列表）：story-trace 正在改这个包，所以从那一件拆到这里。第 5、6 条（case-review 的 PLM 构建核对、独立答案 `plm-build.ts`）要等 core-fixes 合并，放在第二步。

- 分支和工作树：`plm-fields`，目录 `circle-hub-plm-fields`（从 story-trace 开出，依赖已装好；合并时排在 story-trace 后面）
- 可以改的路径：
  - 第一步：`packs/system/plm/**`（functions、system.json、README、测试）。`hub/connectors/testing/plm.ts` 的合成桩只在要加新应答时加，不改现有的值。
  - 第二步：`plan-evidence.md` 第 5、6 条列的路径。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。所有者的规矩：未知只能是过渡状态，写明缺的事实和下一步动作；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1` 对 `packs/system/plm/**`；包的签名检查。第二步再加 case-review 的测试和 `tests/acceptance` 里受影响的。

## 第一步

1. **缺陷内容回传修复说明的字段名**：
   - 缺陷投影的 content 加 `fix_field`：资源设置 `settings.bug_fix_field` 是非空字符串时就是它，否则是 null。
   - 不猜默认字段名，不从别的字段兜底。这条缺陷有没有这个字段，由缺陷转用例包自己看 `fields` 判，这个包不重复判。
   - 设置在 system.json 里声明，照 story-trace 对 `build_story_field` 的做法；README 写明这个字段名要由集成者冒烟以后照真实原件核实。
   - 测试：配了；没配；配成空串。

   部署时 `bug_fix_field` 可以写成 `${var:PLM_BUG_FIX_FIELD}`（hub-variables 的 `--setting-var`，逐项改，别的设置不动）；字段名照真实原件核过以后，由集成者用 `var set … --file` 写进持久部署。包的代码和缺陷转用例包里写的 `settings.bug_fix_field` 修正说明都不用改。`plm.test.ts`、`builds-connectors.test.ts` 里设凭据的两处，到时由 hub-variables 改成按名字设密钥。

2. **按名字读构建列表**：照 `plan-evidence.md` 第 4 条做，content 和 story-trace 的形状合起来：
   - 顶层是 `{ product, product_resolution, builds }`；
   - `builds` 每项保留 story-trace 的 `id, stories, scope_note`，再加 `name`。

   数字键的行为照旧，story-trace 的测试照样通过。
3. **包升一个次版本**（story-trace 的 1.1.0 之后是 1.2.0），README 同步，`node packs/workflow/case-review/packaging.ts sign plm`。

## 第二步（core-fixes 和 story-trace 都合并以后，集成者通知）

- `plan-evidence.md` 第 5、6 条，照那一页做，包括页尾集成者的答复。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。真实冒烟由集成者做。

## 集成者答复（2026-10-24 凌晨，答 codex-f，第三轮收尾核对第 3、4 条）

- 第 3 条：外部标识字节上限那一处修复（472335bd）除了 connectors.ts 的 `reader.read` 提示，还改了 `hub/knowledge/read.ts`、`reader.accepts` 和连接器 README。这几处保留，可改路径补上它们。
- 第 4 条：有权读者面前，外部标识超长是确定、可改的错误，不再中和成“对你不可用”。可改路径补上 `hub/ports.ts`、连接器返回处、`hub/runs/engine/inputs.ts` 和对应测试。码先跟 inputs.ts 里 start_run 其他参数校验失败现在用的码一致；没有统一的码就用 `SUBMISSION_SCHEMA_VIOLATION`，start_run 参数错误用哪个码由集成者在模型修订里定。回答写字节数、上限和缩短键的办法；无权读者照旧只看到中性码（D05）。
