# 任务：技能包解析输出在真实尺寸下超沙箱限额，改为按需取片段

依据：决定 72（通用解析器迁成技能包）、决定 75（B5：xml、xlsx、html、KityMinder 已迁出）；`hub/refs/skills.ts` 的沙箱调用；`docs/hub-r5-brief.md` B5。

## 问题（集成者在真实原件上量得，原件只留在集成者本机，这里只写尺寸）

技能包的解析函数在沙箱里跑，调用限额是 5 秒、输出 64 MiB（`hub/refs/skills.ts:60`，`timeoutMs: 5000`、`outputBytes: 64*1024*1024`）。超过时抛 `ParseError`（"技能包解析未完成"），调用方看到的是 `SOURCE_MALFORMED`。

现在的解析函数把"每个选择器的片段"全部预先算出来放进输出（`document.fragments`），再由 `hydrate` 做成同步的 `locate`。这在小文档上没问题，在真实尺寸上超限：

- `xml-format`：一份 1.99 MB 的 XML（命令树形状，20932 个元素选择器）输出 **100.7 MB** JSON，解析本身只要 0.74 秒。其中 `fragments` 72.8 MB（260397 条：lookup 与 selector 两个字符串 29.7 MB，`data` 26.6 MB，文本 2.4 MB——位置别名和每个属性别名各占一条），`quotation` 15.1 MB。
- `html-format`：`parse.ts` 对块数不超过 200 的页面把每一对块的区间 `b/i-j` 都预算一遍，文本是二次方：一份 46 KB、约 190 块的页面输出 **78 MB**（区间文本 72 MB）；块数超过 200 的页面不预算区间，910 KB 的页面只有 12 MB。
- 后果（已在线上看到）：构建站的列表页 70 页里有 8 页读不出（`SOURCE_MALFORMED`，HTTP 200），所以 `knowledge sync` 列不出对应版本线的构建，该线的根无法重新产出（T2-6 被它挡住）；任何超过约 1.3 MB 的命令树文档在产出根时也会同样失败。B5 的迁移等价测试用的是小文档，没有覆盖到。

## 要做的（加法，对现有技能包和旧运行兼容）

1. **声明**：`skill.json` 的 parser 行加可选的 `locate`（形状同 `function`：`{module, export}`）。改 `contracts/src/pack.ts` 里的 `SkillParser`，跑 `npm run gen:contracts` 并交出重新生成的文件（契约负责人会审那份生成差异），`hub/runs/packs/validate.ts` 里对应的发布校验一并改。
2. **解析输出**：`document.fragments` 改为可选。
   - 有 `fragments`：行为与现在完全一样（急切路径，所有现有技能包和测试不变）。
   - 没有 `fragments`：这份文档是"按需"的，声明里必须有 `locate`，否则 `hydrate` 拒绝；此时 `selectors`、`properties` 只校验是字符串（不再要求每个都在 `fragments` 里）。`quotation` 仍随解析输出（量到的 15 MB 可以接受；见下面的预算）。
3. **`locate` 函数**：输入 `{bytes: base64, options: {…解析选项与限额}, selectors: string[]}`（一次最多 256 个），输出 `{fragments: [{lookup, selector, text, byteRange, data?}]}`，只含能定位的那些，定位不到的不出现；失败时输出和 `parse` 一样的 `{error}`。同样的字节、同样的 lookup，给出的片段必须与急切路径给出的完全相同（相同的 `selector`、`text`、`byteRange`、`data`）。
4. **核心**（`hub/refs/parser.ts`、`hub/refs/skills.ts`）：
   - `ParsedDocument.locate` 的返回类型改成 `Fragment | null | Promise<Fragment | null>`，并给 `ParsedDocument` 加可选的 `prefetch?(selectors: string[]): Promise<void>`。
   - 按需文档的 `locate` 用沙箱调 `locate` 函数，结果缓存在这个文档实例里；`prefetch` 把一批 lookup 合并成一次沙箱调用（每批至多 256 个），缓存命中的不再调。
   - 所有调用点都改成 `await`（`tsc` 会指出：至少 `hub/knowledge/verify.ts`、`applicability-claims.ts`、`produce.ts`、`feeding.ts`、`hub/refs/quote.ts`、`hub/refs/resolve.ts`），并且凡是对同一份文档一次要核多个选择器的地方（一次提交里的多条引文、成批的引用解析）先对那份文档 `prefetch` 全部选择器，再逐条核。同步解析器（核心里的 json、text 等）的行为不变。
5. **技能包**：
   - `xml-format`、`html-format`：`parse` 按**确定的估算**决定走哪条路——同样的字节永远走同一条（估算只用文档本身，比如选择器个数、别名个数、块数，不用时钟）。预计 `fragments` 的 JSON 不超过 4 MB 走急切路径，否则不输出 `fragments`，由 `locate` 按需给。
   - `html-format` 的区间 `b/i-j`：急切路径不再预算二次方的区间，只预算总文本不超过预算的那些；按需路径对任意 `i<j<块数` 的 `b/i-j` 都能在 `locate` 里现算（语义与现有核心解析器一致，旧运行里已有的 `src:<摘要>/html@1/b/<块>` 地址不变，旧引文仍要核得过）。
   - `mindmap-format`、`workbook-format`：用合成的大文档（见测试）量一遍；超预算就同样处理，不超就不动，并在 README 里写明量到的数。
   - 这四个包各自升版本、重签（`node packs/skill/<包>/api.ts sign`），README 加一节"按需取片段"（中文）。
6. **测试**（必须经过真实的沙箱包装 `parserOf` / `callPackFunction`，不能只在进程里直接调函数）：
   - 现生成（不提交大文件）的真实尺寸合成文档：(a) XML，≥ 2 MB、≥ 20000 个元素、嵌套 ≥ 8 层、元素带若干属性（命令树的形状，名字用合成的）；(b) HTML 列表页，46 KB 约 190 块，和 900 KB 超过 1000 块各一份；(c) KityMinder JSON，≥ 2 MB；(d) xlsx，≥ 20000 个单元格。
   - 每份：解析输出 ≤ 24 MB，沙箱内的总时间 ≤ 3 秒；经 `hydrate` 之后抽样（首尾、随机 50 个、HTML 的若干 `b/i-j`）`locate` 的结果，对小文档与急切路径逐字段相等；按需文档的全部 `selectors` 经批量 `locate` 都能定位。
   - `prefetch` 的批量上限与缓存：256 个一批、命中不再调沙箱、同一 lookup 不重复请求。
   - 现有的迁移等价测试、旧运行地址测试全部保持通过。
7. 不动：`contracts/generated` 不手改（只用 `npm run gen:contracts` 生成）；不改其他包。

## 分支、路径和规矩

- 分支和工作树：`skill-lazy-locate`，目录 `~/cursor-trees/skill-lazy-locate`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：
  - `hub/refs/**`（含测试），`hub/knowledge/verify.ts`、`applicability-claims.ts`、`produce.ts`、`feeding.ts` 及它们的测试，`hub/runs/packs/validate.ts` 及测试；
  - `contracts/src/pack.ts` 与重新生成的 `contracts/generated/**`；
  - `packs/skill/xml-format/**`、`packs/skill/html-format/**`、`packs/skill/mindmap-format/**`、`packs/skill/workbook-format/**`；
  - tsc 指出的其他调用点：只改为 `await` / `prefetch`，在回报里逐个列出。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，只暂存明确的路径）。所有者的规矩：未知只能是过渡状态，写明缺的事实和下一步动作；不用关键词匹配做判断。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2` 对 `hub/refs/**`、`hub/knowledge/**`、`hub/runs/**`、`packs/skill/**`、`contracts/**` 和 `.github/checks/*.test.ts`（技能包清单摘要检查）；合入前再对 hub-redesign 合并一次，重跑上面这些并报计数。

## 回报

在终端里回报：提交号、各项测试的数量与结果、量到的输出大小和耗时（四种文档各一行）、`await` 改动逐个列出的调用点，以及没做完或拿不准的地方。集成者会另用真实尺寸的存档原件经沙箱再核一遍。
