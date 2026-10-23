# 任务：需求追溯：照旧按原样状态计数，另按 PLM 自己的阶段字段分组

依据：

- 决定 35 第 21 项：需求按原样状态计数，另按 PLM 自己的阶段字段分组，不自造映射。
- 现在的做法（在 story-trace 和 plm-fields 两条分支上，还没合并）：
  - PLM 系统包的 `plm:stories:<编号>+…` 给出 `{id, status, stage, title}`，状态和阶段各自原样保留，缺的字段记进 `fields_absent`（`packs/system/plm/functions/plm.ts`、`packs/system/plm/README.md`）；
  - 需求追溯包 1.0.2 的 counts 检查（`packs/workflow/story-traceability/functions/counts.ts`）按原样状态计数；阶段只在逐条结论里写出（`functions/check.ts`），没有分组。原样取值和排序用的是 `functions/plm-fields.ts` 的 `scalar`、`scalarKey`、`rawText`；
  - 独立答案 `scripts/real/gold/trace-stories.ts` 和真实场景 `scripts/real/accept/story-traceability.ts` 只核对状态计数。
- 模型元素：W02、W08 R[0]（计数由条目推算）、A01。`node tools/show-element.ts W02 W08 A01`。模型文字不用改；不加词表轴：阶段是 PLM 的原样取值，不是 Hub 的枚举。

- 分支和工作树：`story-status-groups`，目录 `circle-hub-story-status-groups`。story-trace 和 plm-fields 都合并以后，由集成者从 hub-redesign 开出并通知：plm-fields 还在改这个包和 PLM 系统包。
- 可以改的路径：
  - `packs/workflow/story-traceability/**`（functions、requirements.json、samples、testing、SKILL.md、README.md、pack.json、pack-files.ts 和测试）；
  - `scripts/real/gold/trace-stories.ts` 和 `trace-stories.test.ts`；
  - `scripts/real/accept/story-traceability.ts` 和 `story-traceability.test.ts`。
  - `packs/system/plm/**` 不动：阶段字段它已经原样给出。
  - hub-pack-findings 的范围里有 `scripts/real/accept/**`：集成者让两件先后做。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 不自造映射：代码里没有“哪个阶段或状态算已交付、已关闭”的表，也不按名字猜；
  - 未知只能是过渡状态，写明缺的事实和下一步动作；
  - Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 "packs/workflow/story-traceability/**/*.test.ts" packs/workflow/story-traceability/*.test.ts scripts/real/gold/trace-stories.test.ts scripts/real/accept/story-traceability.test.ts`；`node packs/workflow/story-traceability/pack-files.ts --check`。

## 要做的

1. **按阶段分组**（`functions/counts.ts`）：
   - PLM 返回了的需求，按 `stage` 的原样取值分组：同一个值才算一组；字符串、数字、布尔和显式的 null 各自分开；排序用 `scalarKey`。每组写需求数、已追溯数、未追溯数和需求编号。
   - 返回了却没有 stage 字段的单独计数（`stage_absent`），和 `status_absent` 同一写法。PLM 没返回的、详情没读到的照旧单列，不进任何一组。
   - 状态计数照旧。阶段分组和状态计数是两件，不交叉，不合并。
   - 陈述在状态计数后面加一句“阶段分组（PLM 原样）：<阶段> N 个（已追溯 a、未追溯 b）、…；stage 字段未提供 k 个”。陈述最多写前 10 组，多出来的写“另有 M 组”，data 里给全。
   - 测试：两个阶段值；同一个字面、类型不同的值（字符串 "1" 和数字 1）；显式 null；没有 stage 字段；PLM 没返回。断言各组需求数加起来，等于返回了且有 stage 字段的需求数。
2. **不自造映射的测试**：阶段取四个合成值（两个中文、两个英文），每个各成一组、原样显示，没有一个被并到别的组；陈述里不出现“已交付”“已关闭”这类说法。
3. **文字、样例和版本**：
   - `requirements.json` 里 counts 的说明加“另按 PLM 原样的阶段分组”；
   - `SKILL.md` 第 5 步写明：阶段分组原样转述，不说成已交付或已关闭；
   - README 的决定一节写上决定 35 第 21 项；
   - 样例照新输出更新（`testing/make-samples.ts` 重新生成）；包升一个小版本（合并后那一版的下一个），`node packs/workflow/story-traceability/pack-files.ts --write` 重签。
4. **独立答案**（`scripts/real/gold/trace-stories.ts`）：从 PLM 原件独立算阶段分组，取值、排序、缺字段计数和包的规则一样，写进 StoryGold。不导入包的代码，各写各的。测试用合成原件，期望的分组在测试里手写；两边对不对得上，由第 5 条的场景核对。
5. **真实场景**（`scripts/real/accept/story-traceability.ts`）：核对每个阶段组的需求数和已追溯数，以及 stage 字段未提供的个数。陈述里写出来的前 10 组，从客户端看到的文字里核；文字里没写的组，照追溯场景的做法（`scripts/real/lib/pager.ts`）按引用把计数主张的 data 读全再核。测试照现有写法加一组合成回答，含一组对不上的，再加一份超过 10 组的。

真实冒烟由集成者做；PLM 阶段字段的真实字段名由集成者照真实原件核实，不对再改系统包。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
