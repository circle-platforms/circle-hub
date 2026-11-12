# B8：依赖、许可证与来源评估（2026-11-10）

来源：所有者全量计划 B8；基线 aded2ffd，`docs/dependency-license-review`。只读评估：不改依赖、不改声明文件、不联网、不下法律结论；需要所有者决定的事项列在最后。

## 允许路径

- 本任务页

## 方法

读 `package.json`、`package-lock.json`（lockfileVersion 3）和已安装包的 `package.json`；不联网，不核对上游仓库。许可证取自锁文件的 `license` 字段，缺失时看已安装包的 `package.json` 和文件清单。统计命令：用脚本遍历锁文件 `packages`，按 `dev`/`devOptional` 标记区分是否在生产路径上。

## 事实

- 锁文件共 305 个包，其中生产路径上的 292 个；全部来自 `registry.npmjs.org`，全部带完整性摘要。
- 生产路径上的许可证分布：MIT 258、ISC 20、BSD-3-Clause 4、Apache-2.0 3、BSD-2-Clause 2，另有 `Unlicense`（big-integer）、`MIT/X11`（chainsaw，非 SPDX 写法）、`(MIT OR GPL-3.0-or-later)`（jszip）、`(MIT AND Zlib)`（pako）各 1 个，以及 **1 个没有许可证字段的包：`buffers@0.1.1`**。
- 发布包（`tools/build-bundle.ts`）带仓库提交的 git 归档（不含 `foundation/`、`references/`，含根目录的 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`）、`npm ci --include=dev` 装出的 `node_modules`（含开发依赖和各平台的 PostgreSQL 二进制）和官方 Node.js 的 `LICENSE`。

## 发现

1. **`buffers@0.1.1` 在生产依赖树里，没有许可证依据。** 链路：根 → `exceljs@4.4.0` → `unzipper` → `binary` → `buffers`。已安装的包没有 `license`/`licenses` 字段，没有 LICENSE 文件，README 里也没有许可证文字。`exceljs` 是直接依赖，运行时由 `hub/refs/skill-lazy-support.ts` 加载，发布包带整个 `node_modules`。`THIRD_PARTY_NOTICES.md` 说 `buffers` 只出现在一个“仅作参考”的链里，这与现在的锁文件不符。
2. **`THIRD_PARTY_NOTICES.md` 里直接依赖的版本落后于 `package.json`**：声明写 `@modelcontextprotocol/sdk@1.32.1`、`zod@4.6.5`、`read-excel-file@9.3.12`，`package.json` 是 1.32.2、4.6.7、9.3.14；清单里没有 `saxes@6.0.0` 和 `typescript@5.9.3`（二者都在 `dependencies` 里）。声明页自己也写明它不是逐包清单，首次发布前需要从实际制品生成组成与声明清单。
3. **PostgreSQL 二进制的许可证没有随声明出现。** `embedded-postgres` 与 `@embedded-postgres/<平台>` 包本身是 MIT，但发布包经 `npm ci --include=dev` 带上的是 PostgreSQL 的二进制和它捆绑的库；已安装的平台包里只有包装层的 `LICENSE.md`，声明页没有写 PostgreSQL 的许可证。
4. **`typescript` 在 `dependencies` 而不是 `devDependencies`。** 许可证 Apache-2.0，要随制品保留许可证文字和（若有）NOTICE；是否真是运行时依赖需要确认。
5. **选择型和非 SPDX 写法：** `jszip` 是 MIT 与 GPL-3.0-or-later 二选一，声明页已提到要记录所选的许可证；`chainsaw` 写作 `MIT/X11`；`pako` 是 MIT 与 Zlib 并列；Apache-2.0 的 `crc-32`、`readdir-glob`、`typescript` 要保留各自的许可证和 NOTICE。

## 需要所有者决定

- `buffers`：向上游确认许可证依据并留档，或改变 `exceljs` 这条链（例如覆盖 `unzipper`/`binary`、换掉对 `exceljs` 的读取依赖），或接受并写明；在决定前不要把它写成“仅作参考”。
- 声明页：是否现在更正版本并补上 `saxes`、`typescript`、PostgreSQL，还是等首次发布时统一从制品生成清单。
- `typescript` 是否应移到开发依赖；发布包是否仍用 `--include=dev`。

## 没有做

- 没有联网核对任何上游许可证，没有读取各包的完整许可证文字，也不是法律意见。
- 没有改 `package.json`、锁文件、`THIRD_PARTY_NOTICES.md` 或任何代码。
