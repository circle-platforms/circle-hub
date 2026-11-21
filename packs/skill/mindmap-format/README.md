# 脑图格式通用技能包

当前版本 1.0.7 同步模型 20 的生成合约镜像及发布清单；解析业务代码未变。

本包按决定 72 独立发布，不随 Hub 发布；团队版本由管理员显式安装，不按用户分配。个人版本由所有者发布及授权使用。它解释 KityMinder 文件结构，不识别产品、不判断哪些节点是用例，不承担编译、评审或工作簿规则。对象种类 procedure、pitfall 与出处 client_captured 只是 A1 的契约准备；操作记录接收由 B3 完成，不能把这次迁移当成该能力已上线。

## 发布、安装与依赖

用 `node packs/skill/mindmap-format/api.ts sign` 重签，`check` 检查；`stage <目录>` 导出仅含清单文件的发布目录。管理员以 `circle-hub pack publish <目录>` 发布，再 `circle-hub pack install mindmap-format@1.0.7` 安装；`pack uninstall mindmap-format` 停止新运行使用。发布新版本不会自动升级安装版本。技能包不赋予任何原件或产品知识的读取权限。

工作包在 pack.json 声明 `dependencies: [{"pack":"mindmap-format"}]`，可附精确 `version`。管理员安装的版本必须满足声明，否则 start_run 在读取前拒绝，写出缺少的依赖和安装出口。新运行将可用的安装集合锁为 `skills: [{pack,version,digest}]`，因为输入解析器可能来自任一已安装能力；结果锁与主张有效条件包括这些摘要。已锁运行按自己的摘要读取，后续升级、卸载不改历史。安装是全局授权记录绑定包摘要，非用户分配。

## 本地解析工具

已获准读取的原件可用本包 `tools/parse-model.ts --source <原件> --out <新模型文件>` 在本地解析，生成原件摘要及同一 kityminder@1 解析器的模型。工具不联网、不打印原文，输出文件权限为 0600，不覆盖已有文件。模型可能包含原件内容，应保存在当前用户的私有工作目录；不把它写进仓库。再用 `tools/locate-quotes.ts` 在明确选定的节点里定位原文，得到原件字节跨度；它不判断用例归属或语义，结果须由 Hub 核验。这些文件只是准备输入，不是 Hub 的核验结果。

## 解析器迁移模板

1. 将格式算法、选择器定位、格式错误与限额实现放入包自己的 functions。不得导入核心或其他包的实现；跨包调用只走公开 API，运行时仅允许包内模块。
2. skill.json 声明 schema=skill@1、parsers 数组；每项含 parser（精确 parser@version）、media_types、limits（maxBytes/maxDepth/maxNodes 等）和 function（module/export）。相同 parser@version 只有一个安装声明者。只含解析器的技能包不出现在任务列表；另带 workflow.json、requirements.json、checks.json、slots.schema.json 的技能包可提供独立方法，按安装版本使用。
3. 函数只接 `{bytes: "base64", options: {...}}`，在既有包沙箱执行；无网络、凭据、主机文件能力。平台先核清单摘要并限制输入、时间和输出。同一次核验中同一原件的并发引用共用解析，调用结束释放；喂入观察按本次实际采集记录每份文档触发一次。本包保留原解析限额，调用方只能收紧安装声明的限额。
4. 返回 `{document:{parser,model,summary,selectors,properties,fragments,quotation}}`。selectors 是规范节点选择器；properties 是带属性的完整列表；fragments 每项为 `{lookup,selector,text,byteRange,data?}`，lookup 可为位置别名，selector 是规范地址。quotation 含 plain/properties 两套 `{stream,units}`，每个 unit 为 `{selector,text,byteRange,parent,start,end}`。平台仅恢复通用定位接口与逐字核对，不解释脑图。语法错误返回 `{error:{name,message,offset,fix,limit?,max?}}`。
5. 保留 parser@version、规范地址、旧位置别名与引文字符语义。补原格式向量、包沙箱测试、锁摘要升级/卸载测试，再移除核心实现。生成的 protocol.ts 必须由 tools/gen-contracts.ts 生成，不手改。

其余 xml/html/markdown/json/text/xlsx 仍为过渡内置实现，按 B5 照此模板迁移，不代表决定 72 的最终分层已全部完成。测试用的 hub/testing/parsers.ts 显式加载纯格式夹具，仅供单元测试；生产程序集不导入它，也不自动安装本包。

## 运行与历史引用解析

`src:<摘要>/kityminder@1/n/<节点>` 与 `i/...` 地址不变。有 `skills` 锁的运行按该摘要复核；已获授权的逐运行显式声明可用 `circle-hub pack bind-skills <运行> --skill mindmap-format@1.0.2 --reason <理由>` 追加。绑定记录引用原运行记录与包发布记录，保留账号与理由；原运行和原结果不改，不能重新绑定。单独引用的解析直接使用管理员当前已安装的 `mindmap-format` 包版本，不再使用全局事后绑定命令或迁移声明。包升级、卸载、撤回不会替换运行已锁定的摘要；原包不可读取时返回未知及恢复出口。

## 验证范围

合成格式向量覆盖节点、属性、位置别名、NUL、深度与节点限额。hub/refs/skills.test.ts 用临时 PostgreSQL 与合成包覆盖安装、权限、依赖、沙箱解析、运行锁、独立解析、升级与卸载；不接触真实系统。通过这些测试不证明真实手册或脑图已验证。

`testing/baseline` 保存迁移前核心 7bfca782 的七个文件的原始字节和 SHA 清单，只作测试数据，不进发布清单。测试在临时目录重建原模块，不能用搬迁后的实现充当基线。迁移测试枚举 Git 跟踪的所有非存档 JSON（以原解析器是否接受为结构判据），比较全部可读脑图及其嵌套文档的模型与摘要字节；另含大图生成夹具。原有解析器向量也逐项与基线比较。完整计数由测试输出；本轮为 610 份 JSON、147 个文档实例、47 个文件及 1 个生成大图夹具；不把非脑图 JSON 当漏测脑图。

## B5：每个解析器的迁移清单

1. 新建 `packs/skill/<format>/{pack.json,skill.json,SKILL.md,README.md,api.ts,functions/}`；`skill.json` 写原 `parser@version`、媒体类型、限额与沙箱函数。保留旧选择器、位置别名与引文语义，不引入新的正文分类规则。
2. 在新包 `testing/baseline/` 冻结搬迁前核心实现及必需依赖的原字节，记录来源提交和逐文件 SHA。以 `testing/baseline.ts` 的临时重建方式加载；不得拿新实现比较自己，不导入 foundation/references 或真实业务文件。
3. 移动原解析器向量到包内测试；新增 `functions/migration.test.ts`，枚举仓库全部适用夹具与样例，并覆盖生成的大型/边界夹具。模型与摘要逐字节相等，旧选择器与错误语义保持；不删旧断言。
4. 用 `functions/parse.ts` 的通用文档传输形状接沙箱。格式算法及依赖在包内，核心只恢复通用定位接口、核原件摘要、引用语法和逐字引文。需要协议码或闭集快照时在 `tools/gen-contracts.ts` 加生成目标，运行生成器；不手抄词表，不给扫描加例外。
5. 从 `hub/refs/parsers/index.ts` 的过渡默认集合和 `hub/refs/api.ts` 移除该格式的实现/领域类型导出；消费方类型改从技能包公开 API 取，异步读取继续走 `parseDocument` / `recognizeAsync`。原 `src:…/parser@version/…` 写法不改。为实际消费工作包补 dependencies，修各包签名工具保留依赖字段。若多个解析器接受同一媒体类型（例如专用结构与通用 JSON），B5 必须保留原来的专用先行/通用兜底关系，以显式声明和结构测试实现顺序，不按产品名或正文词判断。
6. 测试床显式发布、安装技能包；用 `hub/testing/skills.ts` 的方式注入真实管理注册表。纯单元测试才用 `hub/testing/parsers.ts` 夹具，生产程序集不得导入它。生产环境由管理员安装技能包，不做启动自动安装或事后全局补历史锁。
7. 必补测试：无包/缺依赖有缺失事实及出口；普通用户不能安装/绑定、技能不按用户分配；新运行和结果冻结摘要；升级/卸载/撤回后旧引用仍按原摘要；迁移前未绑定、绑定后、时点后的无锁运行；不带运行号的旧引用；旧运行与旧结果字节不改；权限不扩大、坏摘要不降级；沙箱与限额；同文档并发引用只解析一次，结束不留模型；读取触发的投影保持文档级常数调用次数。
8. 运行 typecheck、gen-contracts --check、原格式/迁移/注册表/引用测试及受影响包和验收测试，并发不超过 2。改已发布包同提交升版重签；新技能包独立发布，记录合成测试计数与尚未验证的真实范围。

## 按需取片段

fragments 的 JSON 估算超过 4 MiB 就不随解析输出，由 locate 按需给，一次最多 256 个。不超过就仍走急切路径。合成脑图 2418953 字节、18001 个节点，估算超过 4 MiB。一次沙箱测量：解析输出 12949399 字节，沙箱内 307 毫秒，fragments 未随解析输出。小文档仍走急切路径。

本次 1.0.5 仅同步第二阶段安全修正的模型 18 生成协议与发布清单，技能业务代码不变。仓库测试通过 `repositorySkillVersion` 读取当前版本。

本次 1.0.6 仅同步第二轮索引修正的模型 19 生成协议与发布清单，业务代码不变。

## 模型 20 同步

当前 1.0.7 只同步决定 131 第三阶段的生成协议镜像与发布清单，解析业务代码不变。个人发布与技能授权由 Hub 的空间命名及当前授权限定，旧团队锁仍按原摘要读取。

## 合线（1.0.19，2026-11-04）

私有集成线在本包上另发了 1.0.2–1.0.3，main 当时是 1.0.18，同号的版本字节不同。本版把集成线的改动带进 main，main 已有的修正保留，版本号高于两边已发布的版本。带进来的改动：本地解析工具 `tools/parse-model.ts` 和 `tools/locate-quotes.ts`（为模板复核准备原文引用跨度）；解析代码不变。

## 模块 case-structure（决定 153、154）

`functions/modules/case-structure/` 是可复用模块：按树位置和声明字段读出用例、前置、动作和期望，不按文字判断角色。工作流在 `pack.json` 的 `embeds` 写 `{"pack":"mindmap-format","version":"<版本>","module":"case-structure"}`，`npm run gen:contracts` 把它生成到 `functions/generated/skills/mindmap-format/case-structure/`。只在这里改模块，不改生成的副本；改了要升本包版本，再改 `embeds` 并重签工作流。模块里的 import 不能离开这个文件夹。

当前 1.0.26 移除 `skill.json` 中历史保留的 `migration_test` 字段并清理旧 `bind-legacy` 说明，解析算法与接口不变。
