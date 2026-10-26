# adoc 成员按显式来源声明解析

所有者指定 adoc-declared-text，从 hub-redesign 的 e00bee4e 建立独立工作树。范围：contracts/src/product.ts 及生成的 product schema，hub/knowledge/{sources,lists,produce}.ts、相关合成测试和 README，FAMX product.json、pack.json、README、adoc/deployment.ts 及其生产集成测试，以及本页。目录身份、主文件及修订绑定规则保留；合并冲突以主线为准。不修改真实来源、环境配置、凭据或部署。

## 声明位置与原因

解析语义属于产品的版本化来源规则：在 ProducerSource 增加可选 parser，供 source 角色或显式 external 来源使用；many 的声明适用于每个成员。FAMX 的 adoc_famx_files、adoc_famy_files 都声明 text@1。

SVN 系统包只负责通用仓库读取，文件可以是真正的二进制；不能把 file 路由全局强制成文本，也不能改写服务器媒体类型。路由的 response/parse 用于读取计划内的响应处理，并不能代替产品成员来源的解析声明。因此保持 SVN 与连接器实现不动，Hub 通用加载器执行产品声明，不认识 FAMX、SVN 文件名或扩展名。

## 行为

- 仅显式 parser 使用注册表精确查找后直接解析；未声明仍走原媒体识别。未登记解析器或声明解析失败直接拒绝并给修正动作，不回退到媒体识别。
- 原件、读取清单、RootSource 和交给生产器的 media_type 都保留实测原值；parser 记录实际采用值。两者不一致时报告“服务器媒体类型 X，按来源声明以 text@1 解析”，带来源身份；系统生成内容注明派生件媒体类型。没有伪造 text/plain 原件。
- 解析结果缓存按摘要、解析器与媒体/字符集选项区分；显式解析不污染媒体识别缓存。单来源加载也按声明区分，避免同一原件先在声明槽位成功后，使未声明槽位误通过；原件字节预算仍按同一外部对象只计一次。
- 单槽位和列表批次都传递声明并汇总差异报告。来源扫描、读取档位、个人凭据限制和核心解析预算全部保留。
- 现有文件组也携带子目录 JSON 投影；组内成员仍统一按 text@1。仅当目录遍历根据父清单的结构字段请求某个确定目录身份时，包读取该辅助成员的完整 JSON 结构并核对原件摘要；不从正文试探 JSON，不按扩展名选择解析器。旧显式 json@1 直接调用保持兼容。
- text@1 的既有 NUL 去除、计数和原始 UTF-8 保留逻辑不变。FAMX 升至 1.7.24 并重签；SVN 包文件未改，无需升版。

## 合成验证

定向 9/9：真实连接器经过回环 SVN 读取含 NUL 的 application/octet-stream 合成 adoc；声明列表/单槽位都成功，nulRemoved=1，原字节和媒体类型保持不变。未声明列表仍拒绝；同一原件的声明/未声明单槽位不会串缓存；另测未知解析器、错误声明不回退、服务器字符集缓存隔离，以及已发布 FAMX 两个文件组的声明。

首轮全套 724/725，定位并修复目录辅助成员在统一 text 模型后的读取接线，保留另一族复用与失败不动旧根的断言；该集成夹具也加入了 octet-stream/NUL 子章节。完整验证按所有者要求覆盖 hub/connectors、hub/knowledge、packs/system/svn、FAMX adoc，测试并发 2；另跑 typecheck 和生成物检查。最终四块测试及相关产品合约测试合计 738/738，零失败、零跳过；typecheck 通过；131 个生成文件一致；FAMX manifest 校验通过。
