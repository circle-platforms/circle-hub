<h1 align="center">circle-hub</h1>

<p align="center">一个标准 MCP 服务器：校验结果、分发任务包、维护知识树。</p>

<p align="center">
  <a href="https://circle-platforms.github.io/circle-hub/">文档</a> ·
  <a href="docs/design/generic-model.md">模型</a> ·
  <a href="docs/hub-r4-brief.md">里程碑</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="README.md">English</a>
</p>

---

circle-hub 是 [Circle](https://github.com/circle-platforms/circle) 的团队 hub，正在重建为一个标准 [MCP](https://modelcontextprotocol.io) 服务器。模型在客户端里工作；Hub 分发工作，在边界校验交回的结果，并留下记录。Hub 不生成内容。

## Hub 是什么

下面是第一个里程碑正在实现的设计；现在已有什么见[状态](#状态)。

- **任务包**说明评审什么、结果怎么核对：要求项模板、槽位模式、检查、给模型的规程，以及包自己的确定性函数。产品包、工作流包、系统包分开，产品知识只在任务包里，不进核心。
- **经过校验的结果**：提交时，Hub 把每个精确值解析成引用，按原文逐字核对引文，在沙箱里重跑任务包的检查，并为每个（条目, 要求项, 判定层）算出终态。每个条目恰好落在一个分区里，未知保持未知。
- **知识树**：每条产品线的每个版本一棵，按内容寻址，由确定性解析器从源文件建成；需要判断的知识留在客户端，经独立的回注运行交 Hub 逐字核验，Hub 不调用任何模型。一次运行锁定它读取的根。

合约定义了六个工具：`list_task_packs`、`upload_file`、`start_run`、`get_nodes`、`resolve_reference`、`submit_result`。记录只追加，其余状态都由记录推出。Circle 将经普通的 MCP 服务器条目连接，里面不出现 Hub 专用的界面。

设计的权威是 [contracts/model.json](contracts/model.json) 里的通用模型，摘要见 [docs/design/generic-model.md](docs/design/generic-model.md)。

## 状态

第一个里程碑已建成并部署，这里还没有受支持的发行。通用模型、由它生成的合约、[架构简报](docs/hub-r4-architecture.md)、`hub/` 下的各个包（服务器、只读控制台、知识树、只读连接器、派发），任务包，以及只监听本机的单机持久部署都已就位；哪些部分已经落地、复核过，还有什么未完，见 [docs/hub-r4-progress.md](docs/hub-r4-progress.md)。此前的任务与审批服务器（截至 0.2.0）已退役，它的简报和交接文档作为[历史记录](docs/README.md#历史记录)保留。

## 运行检查

需要 Node.js 24。PostgreSQL 服务器不用另装：测试用开发依赖 `embedded-postgres` 启动一个临时实例。备份、恢复和部署另外需要同一主版本（现在是 PostgreSQL 18）的 `pg_dump` 和 `pg_restore`：`brew install libpq`，或设置 `CIRCLE_HUB_LIBPQ_BIN`。没有它们时这些测试会跳过，跳过不算通过。

```sh
npm ci
npm run typecheck
npm run verify:contracts   # contracts/generated 与 contracts/model.json、contracts/codes.json、contracts/src 一致
npm run test:unit
npm run test:acceptance    # 临时 PostgreSQL、合成夹具、脚本化模型
npm run verify:references  # 按 SHA 核对冻结的 Circle 基线
npm test                   # 合约检查、单元、验收与参考测试
node --test ".github/checks/*.test.ts"   # 文档检查
```

`node tools/show-element.ts B01 W06` 打印模型元素，`node tools/show-element.ts --vocab partition` 打印一个词表轴。测试和 CI 只用合成夹具与脚本化模型，从不连接真实系统；只有已部署的 Hub 和所有者自己的脚本读取真实系统，而且只读。CI 在 Ubuntu 上运行，包内函数沙箱的测试在那里以 bubblewrap 与 AppArmor 运行，需要 macOS 的测试在那里跳过；另有一个 macOS 工作流在每次推送到 main 和每晚运行它们，每个阶段还在本机 macOS 上完整运行一次，记在进度里。

## 文档

- [第一个里程碑简报](docs/hub-r4-brief.md) · [架构](docs/hub-r4-architecture.md) · [进度与决定](docs/hub-r4-progress.md)
- [通用模型](docs/design/generic-model.md) · [五要素检查单](docs/design/object-standard.md) · [设计索引](docs/design/README.md)
- [兼容矩阵](docs/compatibility.md)：circle、circle-hub、circle-packs 三个仓库彼此的要求。
- [来源清单](references/README.md)：`foundation/circle` 里冻结的 Circle 源基线；按 SHA 核验、运行时从不导入。

## 参与与安全

参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，编程助手见 [AGENTS.md](AGENTS.md)。安全问题按 [SECURITY.md](SECURITY.md) 报告。参与的每个人都遵守[行为准则](CODE_OF_CONDUCT.md)。

circle-hub 与 [circle](https://github.com/circle-platforms/circle) 配合使用：circle 是 agent，circle-hub 是它连接的 MCP 服务器。任务包放在本仓库的 `packs/` 下。

## 许可

circle-hub 以 [Apache License 2.0](LICENSE) 发布。[NOTICE](NOTICE) 写明著作权人，并保留商标：本开源许可仅授予代码与相关文档的使用权，未经明确书面许可，不授予任何使用 Circle、Circle Hub 或相关商标、Logo 及图标的权利。[docs/design](docs/design/README.md) 里的设计规范按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权，引用、借鉴须保留署名并注明原始出处链接。2026-10-13 之前本仓库以 MIT 许可证发布。`foundation/circle` 里冻结的 Circle 源基线保留其 MIT 许可；它、`references/` 里的归档平台和各依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。贡献按 [CONTRIBUTING.md](CONTRIBUTING.md#contributor-terms) 的贡献者条款接受。
