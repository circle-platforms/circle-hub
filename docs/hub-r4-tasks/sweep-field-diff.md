# 任务：维护巡检的结论文字要写出命令定义哪些字段变了

真实验收（2026-10-22，已部署的 Hub、真实 Circle 客户端）发现：被标为“命令已改”的用例，结论文字只写“所在命令的定义有变更（路径）。”，字段级的差异只在数据里（`data.fields`：路径、旧值、新值），而模型读到的回答和完整结果的文字里都没有数据，所以模型无法转述“改了什么”；规程第 3 条却写着“数据里按字段给出路径和两边的值”。独立依据（命令树差异）里这个命令确有字段差异。要让结论文字自己带上最重要的差异。

- 分支和工作树：`hub-sweep-diff`，目录 `circle-hub-sweep-diff`
- 可以改的路径：`packs/workflow/maintenance-sweep/**`（含测试、README、SKILL、`pack.json` 重新签并升一个小版本）。别的路径不动。
- 先读：`AGENTS.md`、`packs/workflow/maintenance-sweep/functions/check.ts`（`commandUnchanged`、`flatFields`）、`sweep.ts`（`FieldDiff`）、README、SKILL.md；`scripts/real/accept/maintenance-sweep.ts`（真实验收场景要在附近文字里找到的写法）。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

1. `commandUnchanged` 的反驳结论文字在现有句子后面加一段：`字段差异 N 处：<路径> 旧 <旧值> → 新 <新值>；…`，最多写 3 处，其余写 `另有 M 处`；一侧缺失（`absent`）写“旧值：无”或“新值：无”；值是对象或数组时用紧凑 JSON；每个值最多 60 个字符，超出的用省略号；整段文字最多 400 个字符（不够就少写几处，仍写 `另有 M 处`）。多个命令路径都有变更的用例，按路径分别写（总共仍不超过 400 个字符）。命令已删除的结论（`command_exists`）不动。
2. 完整数据（`data.fields`）保持不变，仍是全部差异。
3. SKILL.md 和 README 的相应句子改成“结论文字写前 3 处字段差异，全部差异在数据里”；规程第 3 条同步（它是模型读到的）。
4. 测试先写：一处差异、三处、五处（写 3 处加“另有 2 处”）、一侧缺失、长值被省略、对象值、多个路径；`data.fields` 仍是全部；文字里含 `字段差异` 和 `旧`、`新`（真实验收场景用正则找这几个词）。
5. 版本升一个小版本，重新签（`node packs/workflow/case-review/packaging.ts sign maintenance-sweep`，先看现有用法），`pack.test.ts` 的版本断言同步。
6. 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/workflow/maintenance-sweep/**/*.test.ts"`（别和别的终端的数据库测试同时跑：macOS 共享内存段只有 32 个）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
