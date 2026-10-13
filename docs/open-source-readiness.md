# Circle Server 开源前的基础检查

2026-10-11。检查基线为 `26bf0a24d9c196cb11b5e264e732103de8483a06`，检查时 GitHub 仓库仍为 PRIVATE。

**结论：基础检查通过，可以作为开发中的开源项目公开。** 本轮未检出真实凭据。用户随后确认自有内容采用 MIT，完整 platform 自有归档均自主或已获授权可公开；根许可与第三方范围说明已补齐。代码目前是共享基础、参考原件和来源校验工具，还没有正式 server 启动入口。仓库可见性仍保持 PRIVATE，本轮没有执行公开操作。

这是一轮源码公开范围的基础检查，不是生产服务安全验收。具体检查范围和结果见[机器记录](validation/open-source-review-20261011.json)。

## 初审发现与当前处理

### OS-01：初审缺少根许可，现已补齐

状态：已处理。初审位置：package.json 第 7 行及缺失的根目录 LICENSE。

初审根 package 声明 `UNLICENSED`。Circle 的 MIT 许可保留在 [foundation/circle/LICENSE](../foundation/circle/LICENSE)，只凭它不能宣称新增工具和全部 platform 归档都已经开源。16 个归档 package 没有声明自己的许可，也没有平台 LICENSE 原件。

2026-10-11 用户选择 MIT 并确认自有归档的公开权利。当前已添加根 [LICENSE](../LICENSE)，package 许可改为 MIT；自有文档、合成样本和界面资产范围见[第三方说明](../THIRD_PARTY_NOTICES.md)。第三方内容保留各自许可，根许可不重新授权第三方。没有许可时，公开可见与获得使用、修改、分发的许可是两回事，见 [GitHub 许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)和 [MIT 条款](https://choosealicense.com/licenses/mit/)。

`private: true` 用于防止误发 npm 包；确定开源许可后也可以保留，它不等同于 GitHub 仓库私有。

### OS-02：完整私有归档的公开范围已由持有人确认

状态：已确认；技术扫描不代替权利声明。位置：[来源清单](../references/source-manifest.json)、[platform 原件](../references/platform/snapshot)及[初始化记录](bootstrap.md)。

新仓库包含旧私有平台全部 427 份跟踪文件，不只是将来要用的业务代码。范围包括研究记录、模型评测摘要、13 个旧项目的能力索引、GitHub 工作项、截图、样本和历史设计。静态扫描不能证明这些内容都由仓库持有人拥有公开权利，也不能替组织或客户决定公开范围。

本轮未检出 platform 原件中的真实密钥、内部地址或原始业务日志。资料所称的合成样本与实际文件、截图相符。2026-10-11 内容持有人确认归档的 platform 自有代码和合成资料均自主或已获授权可公开。公开 Circle 历史含作者元数据；受控旧会话夹具还保留了本机工作区路径。它们已经来自公开 Circle，不是本次新导入的企业凭据，公开时仍会保留这些信息。

如果某部分不宜公开，保留私有原档，另建有清楚来源的公开材料。不能直接改冻结原件后继续声称原摘要未变；也不能只从最新提交删除文件，因为 `26bf0a2` 中的原件仍可从 Git 历史取得。历史重建或改写需要另行确定范围，本轮未执行。

### OS-03：源码第三方范围已说明，制品发行另作核对

状态：根[第三方范围说明](../THIRD_PARTY_NOTICES.md)已补齐；软件制品发行前逐项核对实际包含的依赖。

Circle 的 MIT 和 models.dev 数据说明原样保留。16 份 npm lockfile 记录了 717 个不同的外部包版本，多数声明宽松许可；其中还有复合许可、CC-BY-4.0 和 MPL-2.0。这个数字包含各参考包与开发工具，不能当成 server 已安装的依赖数量。根 package 当前没有外部依赖。

需要特别登记的项目如下：

| 项目 | 实际看到的内容 | 后续处理 |
|---|---|---|
| models.dev 元数据 | Circle 内嵌压缩数据及原第三方 MIT 说明 | 采用时保留原说明 |
| jszip | lockfile 为 `MIT OR GPL-3.0-or-later` | 核对发行包条款并登记所采用的许可选项；不能因为出现 GPL 字样就宣称整个平台必须 GPL |
| pako | lockfile 为 `MIT AND Zlib` | 两项说明均需核对 |
| lightningcss 及其平台包 | lockfile 为 MPL-2.0 | 实际随制品分发时处理许可通知、对应源码和修改范围，见 [Mozilla 官方 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) |
| caniuse-lite | lockfile 为 CC-BY-4.0 | 若实际分发其数据，核对署名要求 |
| unionfs 4.6.0 | lockfile 没有 license 字段；npm 原发布包 LICENSE 为 Unlicense | 本轮已核实原包文件；作为运行选型实验依赖保留记录 |
| buffers 0.1.1 | chain-v05 的传递依赖；npm 元数据和原发布包未找到许可，原 repository 地址返回 404 | 不能仅从包名推断 MIT。采用该链并打包依赖前，取得许可依据或在正式实现中替换 |
| Jekyll 文档工具链 | Circle 文档 Gemfile/Gemfile.lock，当前没有启用相应发布工作流 | 若以后发行文档站，按实际工具和主题再核对，不算作当前后台运行依赖 |

本轮只读取了锁文件，以及两个缺少字段的 npm 发布包；没有安装依赖或运行它们。锁文件许可字段是线索，未对 717 个包逐一核验发行内容、所有源文件及漏洞公告。仅归档依赖名称与锁文件，不等于已分发那些依赖的实现；第一次软件发行还需要独立的组成清单和许可证通知。

### OS-04：公开内容需要有对应的产品状态和报告渠道

优先级：公开准备。

README 已说明没有正式服务入口；公开时应继续明确这是开发中的项目。历史实验通过、前端模拟权限和来源摘要不能被改写为当前企业服务已可用。Circle 桌面 PR #24/#26 在本轮查询时仍为草稿，不能把它们当作已导入的公开主干功能。

根目录实际只启用来源校验工作流，权限为 `contents: read`，两个 action 使用完整 SHA。原 Circle 的安装、发行和 Pages 工作流，以及 platform 的实验工作流都在子目录，未成为 server 的根工作流。检查基线时，GitHub 只有初始化 Issue、一轮成功的来源校验，没有 PR、release 或 Actions artifact。现有 Actions 日志也纳入本轮扫描。

已补 [CONTRIBUTING](../CONTRIBUTING.md)及 [SECURITY](../SECURITY.md)，当前私有协作者通过私有 Issue 报告。公开操作时启用并核对 GitHub 私下漏洞报告入口；当前没有宣称该公开仓库功能已开启。不要在公开 Issue 收集密钥或原始业务日志。公开仓库后 Actions 历史与日志也会可见，见 [GitHub 可见性说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)。未来提交和 CI 需要持续扫描，不能永久沿用本次结果。

## 本轮实际核对的范围

- 工作树 732 份跟踪文件，源归档 714 份；没有发现跟踪的 `.env`、私钥、凭据配置或生产数据库文件。
- 非浅克隆，全部分支引用可达 222 个提交。Gitleaks 8.30.1 的 Git 模式扫描了 199 个产生补丁的提交；另外逐份导出了全部 2,345 个可达 blob 做内容扫描，覆盖合并提交可能留下的内容。
- Gitleaks Git 扫描有 2 条候选；blob 扫描有 8 条候选，均是这两类文本的历史版本：测试模型名称，以及脱敏测试故意构造的异常内容。已逐条核对原行，不将它们登记为真实凭据。两类文本均在已公开 Circle 的祖先提交内。
- 5 份当前 gzip 原件已展开检查；其中两份 SQLite 夹具仅以只读、不可变模式查询，没有反序列化执行代码或重放工具。它们是受控脚本模型会话。全部可达 blob 的内容投影还展开了 6 份历史 gzip 内容。
- 16 张 platform PNG 截图经本机 OCR 提取可见文字后补充扫描，并对地址、账号和业务内容候选核对。图中为界面演示资料；OCR 有漏识别可能，不能证明每个像素都没有信息。
- 另查路径、URL 中的凭据、私网地址、个人邮箱及内部主机名候选。当前命中主要是 Circle 的示例、合成测试和代码属性；platform URL 是公开资料、回环测试或示例地址。
- 当轮重新执行 `npm run verify:references` 和 `npm run test:references`：714 份原件通过完整性核对，7 项来源与拒绝路径检查通过。

扫描使用内置规则，取消环境配置和仓库 allow 注释的影响，报告进行全值脱敏。没有用旧告警基线忽略结果。原始扫描报告、OCR 和展开文件仅用于本地检查，不将可能敏感的匹配正文写入本仓库。

本轮没有启动 server、数据库、worker、浏览器或网络沙盒，没有执行归档业务模块，没有调用模型或连接设备，也没有做依赖漏洞清单或渗透测试。用户确认后只补根许可、package 元数据与说明，没有改仓库可见性、冻结原件或 Git 历史。

## 开源与融合怎样继续

OS-01/02 已在本轮确认，源码范围与第三方说明已补齐。公开操作前复核最终提交、Issue、PR、Actions 日志及制品，并启用安全报告入口；若期间有新内容或范围删减，重查最终内容及全部可达历史。任何新文件都不自动继承本轮扫描通过。

四对象的[融合提案](bcde-integration-plan.md)可以先准备；实施仍按故事逐项授权。开源成立也不代表企业部署已验收。

## 2026-10-13 补记：许可改为 Apache-2.0，与 Circle 对齐

Circle 于 2026-10-13 改用 Apache License 2.0，并在其[开源就绪记录](https://github.com/circle-platforms/circle/blob/main/docs/open-source-readiness.md)里要求兄弟仓库采用同样的文件和条款。本仓库同日：根 [LICENSE](../LICENSE) 换为 Apache-2.0 正文，附录写明著作权人；`package.json` 的 `license` 改为 `Apache-2.0`；新增 [NOTICE](../NOTICE)，写明产品、著作权人、MIT 历史、第三方说明的位置、设计规范的 CC BY 4.0 条款和商标保留；[docs/design](design/README.md) 里的设计规范按 CC BY 4.0 授权，索引和每篇末尾注明；[CONTRIBUTING](../CONTRIBUTING.md) 加入贡献者条款（每个提交签署 DCO 1.1，并向项目授予可再许可的版权与专利许可）；[SECURITY](../SECURITY.md)、[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)、Issue 与 PR 模板、`.gitattributes` 和文档站配置按 Circle 的样式改写为英文。2026-10-13 之前的提交按 MIT 提交，仍可按 MIT 使用，NOTICE 已写明；提交者只有著作权人本人的几个身份和其代理的编程助手。`foundation/circle` 与 `references/` 的许可和字节不变。OS-01 里"用户选择 MIT"是 2026-10-11 的决定，本补记取代它。
