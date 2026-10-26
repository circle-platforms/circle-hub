# 任务：补齐四项能力的独立验收（架构 6b）

核对（2026-10-23）发现，下面四项能力在真实数据上还没有按 6b 的写法证实。每一部分单独成一个分支，由集成者分别指派；写的都是 `scripts/real/` 下集成者运行的脚本和它们的合成测试。终端不碰真实系统：集成者用 `circle-hub original export` 导出原件、跑脚本、看结果。独立依据（gold）必须自己解析原件，不导入任何包或核心的函数，也不读 Hub 的结论。

- 可以改的路径：`scripts/real/**`（含测试）；别的路径不动，Hub 一侧缺什么先回报。
- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，照真实结构做，不带真实内容；`git commit -s`，合并用 `git merge --signoff`）。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "scripts/real/**/*.test.ts"`。

## A. 用例定位：整棵取样树逐份核对，关联编号能在缺陷系统里找到（分支 `hub-accept-location`）

6b 要求“exhaustive over the sampled agile tree: every document's line, release train and module equals the path convention”，现在只核了一份文档。

1. `scripts/real/gold/locations.ts`：读导出的敏捷平台子树原件（`agile:tree:<根>` 的应答），按架构第 8 节的路径约定（版本线节点 `NNN：x.y.z`、发布火车节点 `NNN: x.y.z-Rn-YYYY/M`、模块节点、文档叶子）独立算出每份文档的版本线、发布火车和模块，并从文档标题和上级目录按同一节的编号写法取出关联的需求和缺陷编号。全角和半角冒号、多余空格要容忍；不符合约定的文档单独列出，不猜。
2. `scripts/real/accept/location-index.ts`：读用例索引的分面视图 `knowledge:facets:<产品>:<构建>?kind=case&by=document,line,train,module`（集成者导出给你的 JSON），逐份文档和 gold 比较，报告相等、不等和只有一边有的文档数，不等的逐条列出（文档、字段、两边的值）。
3. 现有的真实客户端场景 `case-location.ts` 改成接受一个文档清单（至少 5 份，覆盖不同版本线和模块），每份都核版本线、火车、模块、构建候选，以及关联的需求和缺陷编号与 gold 相同；每个关联编号用 `hub-call.ts` 经 Hub 读 `plm:bug:<编号>` 或 `plm:story:<编号>`，读到的算“在缺陷系统里找到”，读不到的照实记下。
4. 合成测试：路径约定的正反例（冒号、空格、缺层）、分面视图的比较、清单场景。

## B. 模板查缺：真实文档上的蜕变核对（分支 `hub-accept-gap`）

6b 的写法是蜕变关系：去掉某一类的全部用例，这一类就要变成缺；加回一个，就要变成有；用例换顺序，报告不变。现在的真实验收只核了用例数。

1. `scripts/real/accept/template-gap-metamorphic.ts`：输入一份导出的真实脑图原件和 Hub 对它的查缺结果。对结果里标为“有”的类别逐个（最多 3 类）：按结果里列出的、覆盖这一类的用例节点，删掉这些节点得到副本 1；在副本 1 里加回其中一个，得到副本 2；把原件每层兄弟节点倒序，得到副本 3。副本都按 `application/json` 用 `upload_file` 上传，再各开始一次查缺运行（`hub-call.ts`）。
2. 判定：副本 1 里这一类是缺，其余类别不变；副本 2 里这一类是有；副本 3 的条目摘要和报告与原件相同。报告逐条写出每个副本、每个类别的预期和实际。
3. 合成测试：副本生成（删、加回、倒序）只改该改的节点，节点编号不变；判定的正反例。

## C. 缺陷转用例：和已有的回归文档比对（分支 `hub-accept-d2c`）

6b：“the drafted cases of defects that already have a regression document are compared with that document (commands and parameters), and every expected result of a draft must be a verbatim quotation of the fix description or the manual”。

1. `scripts/real/gold/regression-doc.ts`：读导出的一份已有回归文档（标题写着它回归的缺陷编号）的原件，用例按 `scripts/real/gold/cases.ts` 的规则取（默认“带标签或带标记”，和 Hub 的默认规则一致；`--case-rule tagged` 只认带标签的节点；真实的回归文档里有整份只按团队模板标记、没有一个资源标签的），独立取出每个用例里的命令行，拆成命令头和参数。
2. `scripts/real/accept/defect-to-case-compare.ts`：输入这份 gold 和集成者跑出的那次缺陷转用例运行的验证结果（导出的 JSON）。报告三件事：草稿用到的命令头里，已有文档也用到的比例，以及反过来的比例（只报告，不判通过）；每条期望结果的引用都已被 Hub 判为逐字（读验证结果里的状态，不重做）；草稿与已有用例完全相同（命令头和参数值都相同）的，gold 算出来的集合和 Hub 查重标出的集合是否相等。
3. 合成测试：命令行拆分（引号、多空格、`no` 前缀）、比例计算、查重集合比较的正反例。
4. 第二轮（真实文档暴露的）：只按启发式拆命令头，在真实写法上会错：命令紧跟在中文后面（“配置”后面直接跟命令）时丢了第一个词，上级分组的标签（function、stress）被当成命令头。改成独立读取集成者导出的这个构建的命令树原件（照 `scripts/real/gold/command-diff.ts` 的做法自己解析，不用 Hub 的目录），在用例文字里按命令全名做最长匹配找出命令头，再取后面的参数；目录里找不到的写成“未识别的命令行”单列，不并进命令头集合。合成测试照“中文紧贴命令”和“分组标签”两种写法各加一例。
5. 第三轮（两边要用同一个拆法）：第二轮后文档一侧按目录拆，草稿一侧仍按启发式拆，重叠比例比的是两种拆法的结果。`defect-to-case-compare.ts` 加 `--commands <命令树原件>`，草稿的命令行按同一份目录做最长匹配，查重（命令头和参数值都相同）也用这个拆法；目录里找不到的草稿命令行单列为“草稿里目录找不到的命令行”，不并进命令头集合。这一项同时是独立核对：Hub 的目录检查判草稿用到的命令都在这个构建里，这里应当为空。没给 `--commands` 时两边都用启发式。合成测试：草稿里参数是不带数字的小写词（例如 `demo pool cfg`），有目录时命令头是 `demo pool`、参数是 `cfg`；一条目录里没有的草稿命令行被单列。

## D. 用例评审：注入缺陷补两类（分支 `hub-accept-inject`）

6b 列的注入缺陷里还差两类没做过：构建里不存在的命令、删掉一组反向用例。

1. `scripts/real/inject-defects.ts` 加两种注入：把一个用例命令行里的一个命令词换成命令目录里没有的词（换成什么写进标准答案）；删掉一个只含反向用例的分组节点（删了哪些写进标准答案）。标准答案在注入时写下，和现有的五种一样。
2. `scripts/real/score-injection.ts` 同步计分：Hub 的命令目录检查在模型引用了那条命令时是否判出（阻断档）；模型有没有发现删掉的反向组（判断，计入召回）。
3. 合成测试：两种注入只改该改的节点；计分的正反例。

## E. 追溯：带缺陷系统状态的独立答案（分支 `hub-accept-trace`）

追溯包现在按缺陷系统里的状态数出已关闭的缺陷，独立答案也要有同样的输入。`scripts/real/gold/join.ts` 已能按 `--plm` 算状态，但还没有一个命令把集成者导出的原件拼成它的输入，现在由集成者手写的草稿脚本拼，而那个草稿既不给缺陷标系统，也不读 PLM 原件。

1. `scripts/real/gold/trace.ts`：输入是集成者导出的这几样：一个构建的修复缺陷页原件（`Bugs_Fixed_with_<构建>.html`）、用例文档原件目录、可选的文档清单（`tree_root` 的用例文档列表）、PLM 批量详情原件（一个或几个文件）、已关闭状态表。修复缺陷页自己解析，链接按地址判系统：PLM 的缺陷页链接、Bugzilla 的 `show_bug.cgi?id=`，页尾 PLM 标记行之后的编号算 PLM。写法照架构第 8 节和 FAMX 包 README 里记的真实形状，重新实现，不导入包的函数。用例按 `scripts/real/gold/cases.ts`，连接和状态按 `join.ts`。输出场景 `scripts/real/accept/traceability.ts` 要的答案格式：每个缺陷的系统、缺陷系统状态或未知原因、是否已关闭、追溯到的用例，以及三项已关闭计数和状态未知数。
2. 合成测试：两种链接加 PLM 标记行的修复页、系统判定、未返回的编号、记录没有状态、端到端出一份答案。

每一部分完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
