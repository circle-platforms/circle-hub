# AsciiDoc 在生产器沙箱中的调研

日期：2026-10-23。基线：hub-redesign 003f518。范围：公开软件、合成 AsciiDoc、最小原型；没有读取真实手册，没有实现或注册生产器，没有修改核心、现有包、根依赖或沙箱权限。

## 结论

**可以，有边界。** 建议后续原型钉住 `@asciidoctor/core@4.1.1` 的官方浏览器 ESM 单文件，随包签名、携带许可证，用现有生产器沙箱运行。它能直接解析作者结构并提供章节、列表、代码块和表格，不需要经过 md。在**实际知识生产器默认档**内，本次 3 MiB 合成文档成功完成：冷调用 961 ms，进程峰值 RSS 555.5 MiB，结构化输出 20.38 MiB。不能由此推断真实手册、任意语法或任意规模都能成功。

两个必要的配套条件：

1. **include 不能直接交给 4.1.1 内建路径。** 它在处理 include 时先导入 `node:fs/promises`，连 secure 模式和自定义 include processor 都未能绕过这个导入；原沙箱拒绝。本原型用一个仅消费输入文件表的受限展开器，保留原文件/行号映射，不读取文件、不联网。
2. **章节和块结构不等于命令语义。** listing 可以用作者声明的 id/role 稳定定位；加粗段落只能提供候选，不能单凭“加粗”证明是命令。取值域先保留表格原文；自然语言约束解释、命令参数语法、歧义处理和生产器接入都未做。示例单列为 `reference_only: true`，不进入签名或判定规则。

另外，4.x 已是原生 JavaScript，不含 Opal。3.0.4 的 Opal 浏览器构建也能加载和解析；没有理由因为“包含 Opal”就断定不能进沙箱。但本次观察到旧版 include 最后一块的 sourcemap 文件名错误，不宜直接当作可信 catalog 来源。[官方迁移说明](https://docs.asciidoctor.org/asciidoctor.js/latest/setup/migration-guide/)、[4.1.1 发布说明](https://github.com/asciidoctor/asciidoctor.js/releases/tag/v4.1.1)。

## 依赖、版本和打包

版本时间来自 npm registry 的 `time`，版本文件的 integrity 来自对应发布元数据；下载仅由宿主机明确执行。4.1.1 发布于 2026-10-05 10:42:45 UTC，已超过两周；3.0.4 发布于 2024-02-12。没有使用 alpha、浮动 latest 或包安装脚本。[npm 原始元数据](https://registry.npmjs.org/@asciidoctor%2fcore)。

| 构建 | 固定版本 | 单文件字节 | 本次运行情况 |
| --- | --- | ---: | --- |
| `build/browser/index.js`，原生 ESM | 4.1.1 | 990496 | AST、完整抽取、规模、属性和确定性测试通过 |
| `dist/browser/asciidoctor.js`，Opal ESM | 3.0.4 | 1737178 | 简单解析、重复抽取、内存 include 扩展通过；发现 include EOF 定位缺陷 |
| `dist/browser/asciidoctor.min.js` | 3.0.4 | 746873 | 只核对发行文件大小；本次没有用压缩版跑原型 |

运行使用的两个文件 SHA-256：

```text
4.1.1  5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d
3.0.4  3ddfae166a45b14b918229b698b961530d6d5d63e25151821689b702412d81be
```

准备脚本同时核对 tarball 的 SHA-512 integrity 和所选 bundle 的 SHA-256。它只取指定 archive member，不执行第三方代码或安装脚本；第三方文件留在临时缓存，不把大 bundle 放进本仓库。未来随包发布时，这个文件必须进入包自己的清单和签名。

沙箱目前只放行少数核心解析依赖，并没有 `@asciidoctor/core`。**裸导入该包已实测被拒**，在根 node_modules 安装它不能解决运行时导入策略。可将 ESM 及其完整依赖树作为包内文件；单文件不是协议的强制要求，但官方浏览器构建已经是单文件，最容易冻结和核对。本原型不需要重新打包工具。核心仍允许原来的纯 builtin，例如 `node:path`；没有改白名单。

许可为 **MIT**，未来复制 bundle 必须同时携带版权和许可通知。4.1.1 tarball 中本次没有找到独立 LICENSE 文件，不能因此省略通知；应从固定版本的[上游 LICENSE](https://github.com/asciidoctor/asciidoctor.js/blob/v4.1.1/LICENSE)一并收录。这里没有进行生产分发；原型代码是本仓库自写，临时缓存里的第三方软件不提交 Git。

## 沙箱限制与实测数字

必须区分两档，不能把 `hub/rules` 的通用默认值误当作知识生产器的值：

| 档位 | 墙钟 | memoryMb | 输入 JSON | 输出 JSON |
| --- | ---: | ---: | ---: | ---: |
| 通用包函数 `hub/rules/sandbox/sandbox.ts` | 10 秒 | 256 MiB | 32 MiB | 8 MiB |
| 实际知识生产器 `hub/knowledge/context.ts` 的 `DEFAULT_SANDBOX.producer` | 120 秒 | 1024 MiB | 128 MiB | 64 MiB |

`hub/knowledge/call.ts` 把第二档传给同一个 `callPackFunction`。原型从 `hub/knowledge/api.ts` 读取该公共常量，并断言它的值，而不是另造“生产器限制”。两档仍使用同一套不联网、不写文件、不起子进程的权限。

`memoryMb` 不是整个进程 RSS 的硬上限：当前看门狗另外加 **192 MiB** 的 Node/编译开销。因此两档的 RSS 采样阈值分别为 448 和 1216 MiB。成功调用的峰值来自子进程 `process.resourceUsage().maxRSS`（KiB），同时记录 heapUsed；失败时只有看门狗终止采样值，不把它当作内核峰值。

环境：Node v24.17.0，macOS arm64，Apple M5 Pro。单并发、每次新沙箱进程；下表是一轮冷调用，不是多轮中位数，也不是生产服务 SLA。构造输入在宿主机，不计入解析计时；墙钟包含启动、导入、解析、抽取和结果传送，解析/抽取时间也包含规范化 JSON 构造。

### 实际生产器默认档：全部成功

| adoc 实际 UTF-8 字节 | 墙钟 ms | 解析/抽取 ms | 峰值 RSS MiB | 结束时 heap MiB | 输出字节 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 262336 | 184 | 90.4 | 143.3 | 42.4 | 1754610 |
| 1049054 | 538 | 408.6 | 315.6 | 102.7 | 7067929 |
| 3146198 | 961 | 777.4 | 555.5 | 301.8 | 21367669 |

输入源文件 SHA-256 与输出 JSON SHA-256（输出不含性能计时）：

| 输入字节 | 输入 SHA-256 | 输出 SHA-256 |
| ---: | --- | --- |
| 262336 | `42fdb8f04c6464712a45ab795e16ac54e5a146fa275dddcaead361ed5adb0e44` | `789dd33291476fa1c468a458531d37777d601ebbb8a03ec19eef707023ff9ba3` |
| 1049054 | `96a29d38ba1f7a055e04fe24b50ee9af793f30f9fdb20b1e9dd248251d8d0cda` | `59212484f858c056478ca0121ee9cc75e575bbdd19c3bb4fa71e5a71767bb50a` |
| 3146198 | `b549a4cb44b414a327504f61270e177903e5f41f5461cfd59d2280a4e7e4f11a` | `ec383096e9bb29ace5f7406347a6703a59153e1653891f4b5aca7e3a59c25699` |

### 通用包函数默认档：边界对照

- 262336 字节：179 ms，143.7 MiB RSS，输出 1754610 字节，成功。
- 1049054 字节：418 ms，306.0 MiB RSS，输出 7067929 字节，成功。
- 3146198 字节：819 ms 时被内存看门狗终止；采样 RSS 471416832 字节，高于 448 MiB 阈值。没有完整抽取结果。
- 只在单次诊断调用把 memoryMb 改为 1024、保留 8 MiB 输出上限后，同一份 3 MiB 文档解析/抽取完成（738.95 ms），然后因 21367669 字节输出而被拒。该混合档只是定位边界，**不是**修改配置，也不是实际生产器档。

结论是本次几 MiB 样例能适配现有生产器档，而不是需要提高生产限制。此样例含密集重复的表格、列表和签名，完整结构输出约为输入的 6.7～6.8 倍；真实文档的结构密度、长段落、嵌套表格和 include 放大会改变这个比例。未来仍须分章/分件、设展开后字节上限，并检查 Hub 后续记录/条目限额；本次没有做入库或端到端生产验证。

## 从 AST 能直接得到什么

最小原型见 [probe.ts](adoc-sandbox/probe.ts)，全部合成资料见 [sample.ts](adoc-sandbox/sample.ts)。

- 章节：context、标题、level、id、parent。沿 parent 构造有序路径；例子是 `Pools(level=1,id=pools) / Add a pool(level=2,id=pool-add)`。
- 表格：head/body/foot 行、单元格原文和 sourceLocation。原型取得三列参数表，包含 `interval / 1-60 / Probe interval in seconds` 和 `mode / on, off / Allowed modes`。这些是作者表格中的取值域候选原文，不把示例或描述自动提升成规则。
- 列表：ulist、olist、嵌套列表块和各 item 的文本。原型保留列表块所属章节路径；完整列表树/连续段落和复杂 description list 还需补齐，不能宣称已做完整 AST 序列化。
- listing/literal：原始内容、id、role、所属章节。原型区分 `role=signature` 和 `role=example`。
- 加粗签名：从 paragraph 原文取候选；例子保留 `signature_verbatim: "*{cmd}* _<name>_ _[interval]_"`，另有展开后的 `expanded: "*demo pool add* _<name>_ _[interval]_"`，并给 `src: "chapters/pool.adoc:4"`。

`signature_verbatim` 和 `src` 采用合成 `packs/product/famx/testing/fixtures/manual-catalog.json` 的字段用途，但**原始 AsciiDoc 的 `*bold*` 不等于既有转换后 catalog 的 `**bold**` 拼写**。后续消费者必须明确标识来源格式；本原型不偷偷转成 md，也没有生成能直接作为现有 manual-catalog 生产输入的完整 catalog。

两个必须做的定位/状态处理已用测试证明：

1. sourcemap 在 listing 上指到开分隔符，本例为第 16 行；签名内容在第 17 行。原型只接受能与原始内容逐字对齐的行，得到 `chapters/pool.adoc:17`，测试回读输入文件表核对。普通 AST 行号不能未经回核就当签名行号。
2. 正文属性变化被解析器保存在 block 的 attribute playback 中。仅 `load()` 后调用 `subAttributes()` 会漏掉后续定义；遍历时先按源顺序调用公共的 `document.playbackAttributes(block.attributes)`。测试分别得到 `demo one`、`demo two`，同时保留相同的原始 `{cmd}` 和各自行号。

官方也说明 sourcemap 不追踪 inline 精确位置，且 include 结尾有已知边界情况；应以源字节核对，不能只相信返回了一个行号。[官方 sourcemap 说明](https://docs.asciidoctor.org/asciidoctor/latest/api/sourcemap/)。

## include 与隔离

4.1.1 浏览器构建的 include 路径先尝试 `node:fs/promises`，然后才到扩展/secure 分支；实测错误为 `IMPORT_NOT_DECLARED`。没有给库开放 fs、fetch 或任何新依赖。3.0.4 的内存 include 扩展能工作，但在 `chapter.adoc` 的最后一个 paragraph 上报告 `<stdin>:3`；这是本次固定版本/样例的实际结果，不推广为所有 includes 都错。

受限适配器只接受调用参数中明确提供的 `files` 字符串表：

- 支持整个本地文件 `include::path[]`，相对当前文件定位，允许已定义属性替换；保留每一行的原文件名与行号。
- 缺文件、URL、绝对路径、上级路径、反斜线、环和超过 16 层都失败。
- `tags=`、`lines=`、`leveloffset=`、条件指令和属性取消不在本原型语法内，拒绝处理。没有用“跳过 include”制造看似完整的结果。
- 尚未实现展开总字节/总次数的独立预算、完整属性和 include 语义；依然有原沙箱内存/时间兜底。这是待评审的受限适配器，不是生产实现。

测试还直接验证：裸导入 `@asciidoctor/core`、全局网络调用、写文件、子进程创建均被同一个原沙箱拒绝。允许从内存展开 include，不意味着允许库自己抓取 URI。官方 include 扩展接口与远程读取能力另见[扩展说明](https://docs.asciidoctor.org/asciidoctor.js/latest/extend/extensions/include-processor/)。

## 确定性

比较对象是最终结构化 JSON 的 UTF-8 字节，**不是**附带性能日志的整个 SandboxResult，也不是带循环引用、对象身份和环境字段的原始 AST。两次独立冷进程对本合成样例输出逐字相等，并记录 SHA-256：

- 4.1.1：替换 Date 构造器/Date.now 和 Math.random，分别模拟 1970 与 2050、0.1 与 0.9，抽取字节相同。
- 3.0.4：只替换 Date.now 和 Math.random，保持真正的 Date 构造器，避免破坏 Opal 对原生 Date/Time 的桥接；两进程的抽取字节相同。**没有**由此证明 Opal 的 Ruby Time.now 被改到 1970/2050。

Opal 确实有对象 id 和时间设施；原始文档属性也可能含时钟。原型白名单输出有序 AST 信息，排序对象键，按源顺序保留数组，不输出运行时间、堆地址或文档创建时间。对 `{docdate}`、`{localtime}` 等时间属性明确拒绝，不能把测试样例重复一致夸大成“任意 AsciiDoc、任意扩展都确定”。后续生产器还需冻结属性策略、版本、文件集合与展开规则，拒绝未支持的环境相关语义。

## 若不用第三方引擎，最小 TypeScript 子集

当前证据不要求重写整个解析器。若无法接受 bundle 或受限 include 适配器，可以把作者格式收窄成以下明确协议；没有真实 adoc，尚不能保证它足够覆盖现有资料。

1. `=…======` 标题、层级栈、显式 `[#id]`/`[[id]]`，冻结自动 id 和重复标题策略。
2. 文档/章节属性定义、使用、作用域、取消与转义，按源位置保存替换快照；禁止隐式时钟/环境属性。条件语法若不支持就拒绝，不默默丢段。
3. 只从输入文件表读 include；明确支持哪些 whole-file/tags/lines/leveloffset 选项，检测环、根路径、深度、展开总量，保留逐行溯源。
4. PSV 表格 `|===`、cols/header、转义竖线、跨行/跨列与单元格格式；不支持的复杂 `a|` 嵌套内容给缺口，不能误拆成范围。
5. 有序/无序/description 列表、嵌套、续行 `+`，listing `----`、literal `....`、source/role/id；示例显式标记且仅供参考。
6. 命令签名只取显式 signature 块或受限、可验证的加粗语法；保留 verbatim、文件:行和属性展开文本。标题、普通加粗说明、示例都不能自动成为命令签名。
7. 取值域来自确定的表格列/标记；范围、枚举、默认值的语法另定合同；出现未支持语义就报告缺口。稳定序列化、输入摘要和源行回核是输出协议的一部分。

这不是建议用一个正则冒充完整 AsciiDoc，也不是已经实现了上述子集解析器。

## 复现与验证

原型放在文档调研目录，独立执行，不自动加入核心单元测试；测试没有隐式联网下载。先在宿主机明确准备公开、固定摘要的软件，然后离线运行测试（沙箱全过程不能联网）：

```sh
node docs/hub-r4-research/adoc-sandbox/prepare.ts
node --test --test-concurrency=1 docs/hub-r4-research/adoc-sandbox/prototype.test.ts
npx tsc --noEmit -p docs/hub-r4-research/adoc-sandbox/tsconfig.json
npx tsc --noEmit
```

本次 8 项原型测试全部通过，0 失败、0 跳过；分别覆盖结构与原文行号、冷进程确定性、正文属性回放、include 失败/受限内存展开、Opal EOF sourcemap 缺陷、权限拒绝、通用档容量边界、实际生产器档规模。测试数字会随机器负载变动，输入/输出摘要应当不变。没有运行真实手册、真实生产器、入库或发布。

## 原件来源这一前提

**已知事实（集成者 10-23 只读列出手册库目录核实，这份调研本身没有访问真实手册库）：手册库只有转换后的 md 和 catalog.json，没有 adoc 原件。** catalog 的 identity 记录各章 adoc SHA-256，签名/取值域记录有 `文件:行`；这些不能还原原始字节，也不能验证实际 include 文件集合。接入 adoc 前必须由所有者给出原件来源、版本和完整 include 文件集合，之后再以摘要核对。本研究没有把合成样例的成功当作原件已具备的证据。
