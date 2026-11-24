---
nav_order: 7
---

# 改一个工作流或技能怎么做

这篇说明写给维护工作流与技能的人：当你修改了一个工作流或技能里的文字（如 `SKILL.md`）、检查规则或函数模块，如何正确升版本号、刷新清单摘要、处理跨包内嵌依赖并让 Hub 在线切换到新版。

> 本文全部命令均针对当前 `circle-hub` 实现与仓库脚本（基线 `34dc51d3c9`）在合成环境实敲验证通过。

---

## 两条必须先记住的规则

1. **已发布的版本号内容不可变**：一旦某个 `<包ID>@<版本>` 发布到 Hub，再次用同一版本号发布不同内容会被校验拒绝（`publish.version_reused`）；仓库检查 `.github/checks/pack-version.ts` 也会拦截“文件或清单摘要变了但 `pack.json` 版本号没变”的提交。
2. **发布务必带 `--stage`**：包的源码目录通常包含 `README.md`、`*.test.ts`、`testing/`、`pack-files.ts` 等非运行文件，不带 `--stage` 直接发布源码目录会因为多出未列出文件而被拒绝。

---

## 一、先分清你的包把版本号写在哪里

仓库里的工作流与技能按清单维护方式分成两类，**改版本号的文件位置不同**（两类在生成清单时都可以走统一入口 `tools/prepare-packs.ts`，唯独四段嵌套子包例外）：

| 维护方式 | 怎么一眼认出 | 改版本号改哪里 | 清单刷新与校验脚本 |
|---|---|---|---|
| **A 类：`pack-files.ts` 管理** | 包目录下有 `pack-files.ts`（如 `test-bed`、`case-compile`、`defect-to-case`、`quality-board`、`regression-scope`、`maintenance-sweep`、`source-read`、`story-traceability`、`traceability`、`bed-install`、`case-location`、`knowledge-contribution`） | **改 `pack-files.ts` 里的 `version`**（不要只改 `pack.json`，工具会按 `pack-files.ts` 重写覆盖） | `node tools/prepare-packs.ts <包目录>`；检查：`node <包目录>/pack-files.ts --check` |
| **B 类：`pack.json` + `api.ts` 管理** | 目录里没有 `pack-files.ts`，而是 `api.ts` 调用 `packagingCli`（全部 `packs/skill/*`、`packs/product/*`、`packs/system/*`，以及 `template-gap`、`case-review`、`case-review-verify`、`criterion-review` 等） | **直接改 `pack.json` 里的 `"version"`** | 顶层包：`node tools/prepare-packs.ts <包目录>`；四段嵌套子包（见下）：`node <包目录>/api.ts sign`；检查：`node <包目录>/api.ts check` |

> **特例（四段嵌套子目录）**：`packs/workflow/case-compile/{recompose,adjudicate,authority,review}` 位于四段路径下，`tools/prepare-packs.ts` 只接受三段路径 `packs/<类型>/<包ID>`（传四段路径会报错`请明确给出仓库 packs 下的包目录`）。修改这些嵌套子包时，直接运行它们自己的 `api.ts sign` 与 `api.ts check`。

---

## 二、标准改包七步（以改 `test-bed` 或 `template-gap` 的 `SKILL.md` 为例）

### 1. 修改目标文件

编辑要改的文档、规则或代码文件，例如 `packs/workflow/test-bed/SKILL.md`。

### 2. 升大版本号，并顺手搜包内是否写死了旧版本号

- **A 类包**（以 `test-bed` 为例）：把 `packs/workflow/test-bed/pack-files.ts` 中的 `version: '1.3.2'` 改成 `1.3.3`。
- **B 类包**（以 `template-gap` 为例）：把 `packs/workflow/template-gap/pack.json` 中的 `"version": "1.2.23"` 改成 `"1.2.24"`。
- **搜包内硬编码版本号**：改完版本后在包目录下搜一下旧版本号（例如 `grep -rn '1.3.2' packs/workflow/test-bed/`）。部分包的测试文件、表格或样例写死了精确版本（实测如 `test-bed/pack.test.ts`、`template-gap/pack.test.ts` 与 `engine.test.ts`、`case-compile/tables/workbook-format.json` 及样例），需要同步更新。

### 3. 重算 `pack.json` 清单与 SHA-256 摘要

按路径层级运行刷新工具（或用 `--changed <基线提交>` 一次刷新相对某次提交改过的全部顶层包）：

```bash
# 顶层三段包（A 类 / B 类通用）
node tools/prepare-packs.ts packs/workflow/test-bed
# 或：node tools/prepare-packs.ts packs/workflow/template-gap

# 如果是四段嵌套子包，改用各自 api.ts sign：
# node packs/workflow/case-compile/recompose/api.ts sign
```

### 4. 本地自检与跑包内测试

```bash
# A 类包检查清单新鲜度：
node packs/workflow/test-bed/pack-files.ts --check
# B 类包检查清单新鲜度：
# node packs/workflow/template-gap/api.ts check

# 跑这个包自己的测试（建议带上，防止测试或表文件还引用旧版本号）：
node --test "packs/workflow/test-bed/**/*.test.ts"
```

### 5. 发布前试运行（`--dry-run`）与正式发布

先试运行看增量变更对比和样例结果（确认没有 `publish.version_reused` 报错，且变更文件符合预期）：

```bash
export CIRCLE_HUB_DATA_DIR=<数据根>
./bin/circle-hub pack publish packs/workflow/test-bed --stage --dry-run
```

确认无误后去掉 `--dry-run` 正式发布：

```bash
./bin/circle-hub pack publish packs/workflow/test-bed --stage
```

### 6. 按包类型让新版生效，并按需退役旧版

这一步各包类型不同，不要漏做：

| 改的是哪类包 | 发布后必须怎么做 |
|---|---|
| **工作流（`workflow`）** | 团队/个人分配绑定的是包 ID（例如 `test-bed`），新版本发布后已分配的用户自动可见新版，无需重复执行 `pack assign`。要让客户端停止使用旧版，再执行退役命令：<br>`./bin/circle-hub pack retire test-bed@1.3.2`<br>（已有的旧运行仍可照常读取和完成） |
| **通用技能（`skill`）** | 仅发布不会自动切版本，必须显式安装新精确版本：<br>`./bin/circle-hub pack install <技能ID>@<新版本>`<br>若这个技能被宿主工作流通过 `embeds` 内嵌，继续看下文**第三节**。 |
| **产品知识来源（`product`）** | 若该产品尚未启用，执行 `./bin/circle-hub pack activate <产品ID>`；若知识树规则或来源变动，按需跑 `./bin/circle-hub knowledge sync --product <产品ID>`。 |
| **业务系统接入（`system`）** | 系统包发布新版后，需要把已建资源改绑到新版本：<br>`./bin/circle-hub resource update <资源ID或名字> --system-pack <系统包ID>` |

### 7. 验证上线结果

在终端与客户端分别确认：

```bash
./bin/circle-hub pack list
```

确认新版状态为 `已发布`、旧版已标记 `已退役`（若有）。在已接入该工作流的客户端上调用 `list_task_packs`（可传 `{"pack_id":"test-bed"}`），确认返回的已是新版本号（如 `test-bed@1.3.3`）。

---

## 三、特例：修改被工作流 `embeds` 内嵌的通用技能

仓库中并非所有技能只靠运行期引用：例如 `packs/skill/mindmap-format` 的 `case-structure` 模块被 `packs/workflow/case-compile` 和嵌套包 `packs/workflow/case-compile/recompose` 按**精确版本号**写进了 `"embeds"` 字段并把模块代码拷贝到了宿主的 `functions/generated/skills/` 目录。

当你改动了被 `embeds` 引用的通用技能（比如把 `mindmap-format` 从 `1.0.24` 升到 `1.0.25`）时：

1. **先改技能并刷新技能清单**：
   改好技能文件、`packs/skill/mindmap-format/pack.json` 版本号后，运行：
   ```bash
   node tools/prepare-packs.ts packs/skill/mindmap-format
   ```
   此时运行 `node tools/gen-contracts.ts --check` 会立即报错，指出有哪些宿主包的 `embeds` 还停留在旧版本（这就是你需要联动更新的全部宿主包）。

2. **同步升级宿主包自身版本与 `embeds` 版本**：
   - 在 `packs/workflow/case-compile/pack-files.ts` 中同时升大宿主 `version` 和 `embeds` 里的技能版本；
   - 在 `packs/workflow/case-compile/recompose/pack.json` 中同时升大宿主 `version` 和 `embeds` 里的技能版本；
   - 如宿主包的表文件、样例或测试里也写了宿主版本号（如 `case-compile` 的 `tables/workbook-format.json`、`samples/` 与 `pack.test.ts`），一并更新。

3. **按「先刷宿主清单 -> 再同步内嵌文件 -> 再重算摘要」顺序执行**：
   `gen:contracts` 读的是宿主 `pack.json` 里的 `embeds`，因此必须先让宿主 `pack.json` 拿到新 `embeds`，再运行 `npm run gen:contracts` 拷贝模块字节，如果生成的内嵌文件有改动还要再刷新一次 `pack.json` 的文件摘要：

   ```bash
   # 1) 让宿主 pack.json 先反映新 embeds 与宿主新版本
   node tools/prepare-packs.ts packs/workflow/case-compile
   node packs/workflow/case-compile/recompose/api.ts sign

   # 2) 按新 embeds 同步与校验内嵌技能代码
   npm run gen:contracts

   # 3) 若生成文件有变化，重算宿主清单文件摘要
   node tools/prepare-packs.ts packs/workflow/case-compile
   node packs/workflow/case-compile/recompose/api.ts sign
   ```

4. **全量自检后再发布**：

   ```bash
   node tools/gen-contracts.ts --check
   node packs/workflow/case-compile/pack-files.ts --check
   node packs/workflow/case-compile/recompose/api.ts check
   ```

   之后别忘了把新版技能（`pack publish` + `pack install <技能>@<新版本>`）和宿主工作流（`pack publish` + 按需 `pack retire` 旧版）都发布到 Hub。

---

## 相关页面

- 从零部署、建团队、配置连接与首次运行：[十分钟上手](quickstart.md)
- 七项用例工作流的使用规范：[Hub r4 使用指南：七项用例能力](hub-r4-guide.md)
