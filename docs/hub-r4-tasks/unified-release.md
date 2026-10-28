# 任务：统一六目标发行

依据：所有者 2026-10-28 要求 Hub 的版本、六目标发行和 GitHub Release 管理与 Circle 一致；Windows 由 GitHub Actions 验证。仅本地准备，不推送、不建标签或 PR、不发布、不改远端设置，不传播私有历史。

分支：`unified-release`，从 `hub-redesign` 开。允许路径：本任务页与 `scripts/release/**`。不修改 Circle、foundation、references、HANDOFF、平台运行数据或现有工作流。测试并发由集成者调度。

## 设计与次序

1. 独立发行完整性模块。沿用 Circle 的发行根 `release.json`、版本/目标/Node 版本/提交/文件清单结构（Hub schema 为 `circle-hub-release/v1`）；发行身份含唯一版本、源码提交、六目标之一；每目标 Node 24 原始归档名和 SHA-256 必须与审核的固定表一致。逐文件清单包含字节摘要、大小、可执行位，以及 npm 必需的内部相对链接；拒绝越界、悬空链接和特殊文件。清单本身不自哈希，外层归档另附 SHA-256。
2. 原生构建器在每目标 runner 执行普通 `npm ci --include=dev`，保留生命周期脚本与依赖链接。Hub 的 PostgreSQL 位于开发依赖，不能使用 Circle 的生产依赖裁剪或忽略脚本。精确检查已安装 PostgreSQL 目标和原生可执行文件；不能以 x64 模拟冒充 ARM64。只归档显式允许的运行源码和依赖，不夹带环境文件、历史、日志和真实数据。
3. 安装器先核验外层归档摘要、身份和逐文件清单，再在临时目录运行包内 Node 检查 CLI 版本；通过后原子切换。升级保留数据库、对象、密库和配置。安装与运行数据目录分离，失败保持原版本。
4. 每目标以临时数据根执行原生构建、搬迁、安装、升级、文件篡改/新增/缺失/链接越界拒绝、数据保留及服务/数据库/沙箱真实冒烟；任何必需项跳过或未跑都不满足发布。现有安全约束不得弱化。Windows 后台服务、系统级函数隔离和 ARM64 PostgreSQL 缺口必须先解决。
5. 先本地准备六 runner 的只读 Actions 验证方案：Linux x64/arm64、macOS x64/arm64、Windows x64/arm64；Windows 只能以其 Actions 原生结果完成验收。公开同步前需单独授权，发布工作流以后仅在审核的公开快照上启用，绝不推私有分支历史。
6. GitHub Release 先建 draft，六目标同版本同提交包与原生冒烟均齐全、摘要核验后才允许发布；任一缺失保持 draft。手动演练永不发布，失败可重跑。当前没有创建 draft 或发布的代码与权限。

## 当前交付与边界

已适配 Circle 的 `scripts/release/node-runtime.json`（Node 24.21.0 六目标归档名和摘要）；这是本地 Circle 当前固定表的复制，尚未重新下载原始归档验证。已交付 `scripts/release/integrity.ts` 的清单校验和明确拒绝发布入口，以及合成目录回归。不是构建、安装、升级或六目标支持已完成的声明。`assertReleaseReady` 无条件拒绝发布：Windows 服务、隔离、ARM64 PostgreSQL及六目标原生冒烟均未齐备；没有空壳成功收据。构建安装器、原生冒烟、外层归档验证、工作流与 Release 管理仍未实现。现有平台部署命令不依赖此模块，不能把此模块当成已接入的发布防线。

独立清单校验只证明给定目录与输入清单一致；SHA 不证明来源可信，模型判定、业务正确性、真实系统效果均不由它建立。信任根是未来审核的固定运行时表、源码提交和 Actions 原生证据；此阶段没有这类发布证据。

## 本阶段验证

`node --test --test-concurrency=2 scripts/release/integrity.test.ts`：首次 1 通过、1 失败，发现 macOS 临时目录系统路径别名使合法链接被误判；检查根目录本身后统一真实路径修复。再次运行 2 通过、0 失败、0 跳过。`npx tsc --noEmit`：退出 0。`git diff --cached --check`：退出 0。均只使用临时合成文件，没有原生构建/安装/升级、PostgreSQL、服务或沙箱验证；未运行完整套，不能作为合入或发布验收。测试窗口已归还集成者。

## 独立审查修复：特殊文件名

审查发现 `__proto__` 根文件名写入普通对象时会修改原型并被清单遗漏。追加回归后先运行同一 own tests：2 通过、2 失败，确认普通文件及链接的特殊名字均未成为自有清单项。修复为无原型字典，同时替换会剥离 `__proto__` 的 `z.record` 文件清单解析：逐个自有条目保留名字并执行原有严格 Entry 校验。新增、修改已列特殊文件、特殊链接变更/越界与清单自身为链接均有反例。

修复后 `node --test --test-concurrency=2 scripts/release/integrity.test.ts`：4 通过、0 失败、0 跳过；`npx tsc --noEmit`：退出 0。当前链接反例在 macOS 实际执行；Windows 缺链接创建权限时会明确跳过该目录级合成项，这不构成 Windows 发布验收。仍未实现完整发行，发布阻断函数仍未接入任何运行入口；本修复不改变这些边界。
