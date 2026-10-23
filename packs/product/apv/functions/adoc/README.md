# adoc 受限展开与中间模型（K4b 第一步）

入口是 `index.ts` 的 `compileAdoc(input)`（也是 default 导出）。本阶段只完成文件表展开、条件与属性、源行回核、组成身份和整组拒绝；没有注册知识生产器，没有改同步计划或 K1 的文档落点，也没有提取命令签名/取值域或停用 catalog.json。第二步由集成者通知后接入 K1。

## 输入及组成身份

输入形状为 `{main, revision, files, attributes?}`。`files` 是相对路径到 `{text, revision, sha256}` 的表：

- text 是 UTF-8 原件解码后的原文，保留 NUL、CRLF；不接受已去掉 NUL 却仍声明原件摘要的文本。单独的代理码点拒绝。
- revision 是整组读取时使用的 SVN 修订号，每份文件必须与它相同；不是各文件最后修改号。所有声明的文件（包括未引用者）的原始字节摘要都会先核验。
- attributes 缺省为空；值限单行字符串或布尔值。外部属性是否覆盖源中定义遵循引擎标准优先级。哪些名称族用什么开关仍由所有者决定，不推断品牌。属性名按引擎语义小写；大小写折叠后的重名、时间类属性、执行策略属性和可注入预处理指令的值拒绝。
- 组成记录含主文件、修订号、排序后的完整文件/摘要表、声明属性、引擎版本与摘要、展开策略和预算；sha256 是这份身份对象的规范 JSON 摘要。后续真实组成记录还需由知识生产器绑定这份中间产物及包版本。

成功给出 `{ok:true, composition, model, report}`；失败只给 `{ok:false, error}`，没有可应用的部分 model/组成摘要，error 写缺口和下一动作。同样输入的 JSON 字节一致；文件表/属性对象的插入次序不改变产出，换属性集会换身份。`compileAdoc` 是纯函数，不会写知识根；第二步调用方必须把失败当整组失败，保留旧根，不能跳过坏章后提交剩余章节。

预算固定为：128 份文件、原件共 16 MiB、展开共 8 MiB、16 层 include、512 次 include、250000 行、1024 个条件分支、250000 个引擎节点。测试的第二参数可收紧预算；生产 default 入口不从输入接受预算覆盖。外层仍受原生产器沙箱的时间、内存及 JSON 输入输出限制。

## include、条件及属性

只展开文件表里的 `include::相对路径[]`，按出现次序递归，不排序章节。允许用此前实际生效的源属性组成 include 路径；属性状态由引擎读取前缀并按公共 playback API 回放，适配器不重写属性求值规则。不插入虚构的段落分隔：作者要在应分段/分章的位置保留空行。

缺文件、URI/绝对路径/上级路径/反斜线、任何 include 选项、条件中的 include（即使分支未选中）、循环以及各项预算超限，都拒绝整组。非独占一行的 include 或不支持的条件语法也拒绝，不让引擎走内建 include I/O。主文件未 include 的文件只在 unused_files 列出，不进入书。

ifdef/ifndef 由固定引擎求值，支持其 OR/AND 与单行形式；不支持 ifeval。每个分支的报告含条件原文、源文件/行号、是否保留、父分支和被去掉的来源行号范围/行数。嵌套分别报告，没有“整书删掉多少块”的计数，也不单独解析被去掉的片段数块。为观察同一时刻的引擎属性，条件检查使用固定标记的小谓词探针，且计入父分支状态；原件仍由主引擎解析，不自行实现条件表达式。

正文属性变更在 AST 遍历时调用公共 `document.playbackAttributes(node.attributes)`；raw 和 expanded 分开保留。任何使用、定义或条件引用 docdate、doctime、docdatetime、docyear、localdate、localtime、localdatetime、localyear 都拒绝，包括未选中的分支；不输出引擎的时钟、对象身份或环境元数据。

日志使用公开 LoggerManager 的串行会话，结束时恢复；不传会触发 `node:async_hooks` 动态导入的 load.logger 选项。未修改第三方引擎字节或沙箱导入白名单。同进程的并发调用也串行隔离日志。

## 模型与原件行号

`model.expanded_text` 是 include 展开、去 NUL、换行归一为 LF 后的文本，保留条件指令；`line_map` 对每行保留原文件/行号。`blocks` 只来自条件求值后的 AST，含引擎 kind、章节级别、标题、作者 id/role、章节路径、raw/expanded；表格保留 head/body/foot 各单元格。此处不把 listing、粗体、标题或 role 自动提升成命令规则。

每个 sourcemap 行号只作为候选。定位器在固定的邻近范围尝试逐字匹配，再独立回读原文件对应行；单一匹配才发 `src:<原件摘要>/text@1/l/<a>-<b>`（单行用 l/a）。同时保留 text@1 会返回的原文 verbatim；跨文件或不连续源行分成多个 origins，不能造一个连续范围。NUL 去除与 CR/LF 切分和 text@1 保持一致，原件摘要仍按原始字节算。

不能唯一回核的块/单元格没有引用；unverified_count 给出全部数量，unverified 保留前 100 个诊断，超出时 unverified_examples_truncated 为 true。模型本身仍明确保留空 origins，不能拿“有 sourcemap”当作已证明的位置。没有直接源码的容器（例如表格容器）也不捏造范围，单元格单独回核；复杂列表、跨上下文的精确范围仍需第二步定位器处理。自动回核失败后，本阶段禁止发引用并说明后续修复动作。

各文件的 NUL、CRLF、LF、CR 数分别报告；UTF-8 BOM 存在时另报 3 字节，行回读按 text@1 的解码规则去掉文件开头 BOM，原件摘要仍包含它。超过合法等级的等号标题列在 invalid_headings，不提升为章节；引擎消息保留在报告，错误及未闭合块导致整组拒绝。所有验证只有合成原件，尚无真实手册或知识根验收。

## 第三方引擎来源

- 上游 `@asciidoctor/core@4.1.1`，在仓库外 `npm pack --ignore-scripts` 取得 `package/build/browser/index.js`，原字节复制为 `vendor/core.mjs`，990496 字节。
- SHA-256：`5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d`，与调研 adoc-sandbox.md 的固定摘要一致。
- LICENSE 来自固定标签 `https://raw.githubusercontent.com/asciidoctor/asciidoctor.js/v4.1.1/LICENSE`，原字节放在 `vendor/LICENSE.txt`，MIT 版权和许可完整保留；SHA-256 为 `5dc8600d56eb0cae83dcdecde260d5b5568e7a5431fb9a9cf7906d02818bac7e`。
- `core.d.mts` 只是本适配器用到的 API 声明。没有 npm 运行依赖、安装脚本、库补丁或新的沙箱权限。

## 合成规模验证

2026-10-23，macOS arm64、Node v24.17.0，单并发、一个冷沙箱进程。引用的公共档位是 `hub/knowledge/api.ts` 的 DEFAULT_SANDBOX.producer：120000 ms、memoryMb 1024、JSON 输入 128 MiB、输出 64 MiB。RSS 看门狗原有额外开销为 192 MiB，没有提高任何配置。

12 章表格密集组共 3146572 字节；一次实测：墙钟 1041 ms，解析/抽取及一次结果序列化 752.8 ms，进程峰值 RSS 647008 KiB（631.8 MiB），结束时 heap 244540504 字节，输出 JSON 42004120 字节。RSS 在首次结果序列化后采集，不能冒充后续传输阶段的内核峰值；传输仍受原看门狗约束。这是一轮合成容量证据，不是 SLA，也不证明真实 adoc 任意语法或规模可用。

测试命令：`node --test --test-concurrency=1 "packs/product/apv/functions/adoc/*.test.ts"`。冷进程在不同 Date/Math.random 下的结果字节相同；同一沙箱仍拒绝网络、文件写入和子进程。没有 OS 网络隔离的环境明确跳过沙箱证据，不降低权限来凑通过。
