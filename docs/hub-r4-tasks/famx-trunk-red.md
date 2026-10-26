# FAMX 主线红测收尾

所有者指定接手 famx-trunk-red，保留原终端的 20 个提交，先合入 hub-redesign（46ca3521，含 a30564a2、seed-adoc）。合并时版本取 max(1.7.21, 1.7.9)+1=1.7.22；本次包实现修复再升 1.7.23 并重签。

## 范围

本次修改 packs/product/famx 下 README.md、product.json、pack.json、applicability-integration.test.ts、functions/manual.ts、manual.test.ts、manual-links.test.ts、adapters.test.ts、adoc/entries.ts、cases-nodes.test.ts、deployment-options.test.ts、unversioned-cases.test.ts，以及本页。前任已有的通用链接契约、生成物、来源解析修复随分支保留，没有撤回或丢弃；未接触真实系统、配置、凭据、7420、推送或部署。

## 依据与修复

- 决定 60：结构位置才主张命令；代码块取整行、表格用精确列角色 command_signature@2。正文标记原文是 command_mentions，读时 exact 链接，unmatched: mention 不构成漂移。
- 表格实现回归：原 cellAnchors 只试整格，README 已声明的分隔和多跨度规则没有执行。先解析强调及匹配参数括号，再按现有单元格分隔语法切分，空白连接同一签名跨度，参数内部标点不切分；所有参数和路径仍由锁定树完整核对。描述格保留提及，当前参数/变体取值只按完全相等判定；共同祖先也按原文相等。
- 代码块实现回归：markdown@1 原样保留围栏，投影误把围栏行当命令。按 Markdown 围栏结构取内容，原条目和引用仍保留完整原文；不剥设备提示符或从散文抽命令。合成分页用例现在将 150 个漂移字面放入整行代码块，同时核验正文精确链接与未匹配提及。
- 示例实现回归：新增 command_mentions 后，示例分流遗漏该字段，匹配目标存在时会误链接。该字段与旧命令字段一起移入 reference，保留原文和 reference_only 标记，继续不参与链接/漂移判定。
- 散文条件已退役：原测试中的各种肯定、否定、列表、标题及表格条件全部断言 null 和双未声明，不再分类。适用性集成测试改用 famx-applicability@1 声明块，保留逐字来源核验、冲突、内层覆盖、警告截断后的来源与读时判定覆盖；同章节显式声明在显示上是直接条件。
- 其余落后期望：XML 合成夹具在前任提交中已修好，正向接线重新期待可用，同时另造畸形 XML 保留拒收测试；标签极性从精确声明表读取；未声明页面后缀不猜为 customer；无锁定语法的用例不从散文抽短语，旧不透明哈希改核新来源身份及完整新增字段差异；三个闭集变量恢复原有紧凑格式，不改字段值。
- 树改变可以改变完整语法是否核验成功及派生类型；树间不变性测试改为核对全部来源片段与原件覆盖，并核查已移除命令不会继续放在命令路径，未将核验结果强制成相同字节。

## 验证

接手并合主线后的 manual + manual-links：78 项，48 过、30 失败；完成后 78/78。第一次全 FAMX 检查（手册组修好后）632 项，622 过、10 失败；收尾全 FAMX 632/632，无跳过。npm run typecheck 通过；生成物检查 131 文件一致；链接与产品契约相关测试 45/45。所有测试命令 --test-concurrency=2，顺序执行，无真实数据或模型。
