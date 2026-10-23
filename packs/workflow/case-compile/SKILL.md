# 用例编译（执行计划核对）

把评审过的用例编成执行计划：你按受限结构填槽，Hub 在边界上重跑核对（合约、台架、命令目录、期望来源、确定性）。Hub 的结论是事实或未知，从不写“可以运行”；合约是合成的时，每条结论都带“按合成合约核对”，所有结论都带“不证明在真实设备上跑得通”——转述时这两句一句都不能省。

1. 开始运行：pack 写 case-compile；inputs.subject 绑定评审过的用例脑图（`{"external":"agile:mindmap:<文档号>"}`）；inputs.contract 写 `{"external":"doc:doc:compile-contract"}`；inputs.inventory 写 `{"external":"doc:doc:bed-topology"}`（管理员用 circle-hub doc put 发布的命名文档）。可选参数 case_rule：tagged 只认标签，marked（默认）带标签或带标记都算用例。开始运行时按提示选目标构建（命令目录 commands@1）。
2. 运行开始后每个条目是一个用例（编号 <文档号>:<节点号>）。逐个为它们编执行计划：先读条目的 fields（steps、expected），再按第 3、4 步填槽提交。
3. 受限结构（模型 W05，类别都是有限集）：每条目提交一份 `slots.plan`（一条主张），你只填槽，不写执行计划：
   - `bucket`：这份用例在哪个台架跑，写清单里的台架名（例如 bed-a）。
   - `blocks`：块，只能写 setup 或 teardown，没有写 []。
   - `steps`：步骤列表，每步 `{object, method, params}`。（对象，方法）只能是合约里声明的，禁用的组合（例如 dut.reboot）不能用；参数按合约写：必填的一个不少、未声明的一个不写、类型和范围要对。合约里 `command: true` 的参数写命令行（必须在目标构建的命令目录里）；`address: listen|backend|target|virtual` 的参数写字面地址：监听地址必须是被测设备的接口地址且同网段有触发设备，后端地址必须是服务器设备（type=server）的接口地址（清单 services 声明的服务不算），盲地址（所在网段没有触发设备）不能当监听或虚拟地址，台架之外的地址不能出现；分配到的地址（经 test-bed 预订的）可以用。地址按数值比对，记法随意（2001:DB8::10 和 2001:db8:0:0::10 是同一个地址）。
   - `expects`：期望结果列表，每条 `{text, quote:{reference, text}}`。每个期望结果都必须有逐字来源：quote.reference 指到用例原文、缺陷修复说明或手册的片段（src:/rec:/tree: 引用），quote.text 是逐字内容；而且期望文字本身（空白折叠后）必须是 quote.text 的片段——可以截取，不能改写。模型自己编的期望结果会被拒绝。
   - 主张顶层 `quotes` 照抄 expects 里的全部 quote（边界逐字核对用），`text` 写一句计划摘要。
4. 执行计划不由你写：Hub 的确定性生成器从槽位生成 exec-plan@1 的规范 JSON（步骤从 1 起编号；每步只取合约声明的参数，缺省值按合约填上；所有键按码位排序、无空白），再用另一个读取函数把它解析回来，和槽位逐项比对，一致才支持。支持结论的文字写出计划文本的 sha256，`data` 里有完整的计划文本和 sha256——转述结论时带上 sha256；要读执行计划全文时读 `data.plan`。生成或回读失败记未知（出件失败），不是你填错了什么的同义词；它指出的是出件环节本身。不要自己生成或改写执行计划的 JSON。
5. 修正说明怎么读：提交整份不被接受时，回执逐条给出拒绝码和修正（例如 QUOTE_MISMATCH 是引文不逐字，REFERENCE_UNRESOLVED 是引用解析不出）；改正后重交。单条结论被退回修复时，回执给出哪一步、哪个参数或哪个地址不对和剩余修复轮数；按指出的位置改正后重交，不要绕过。
6. 提交样例：见 `examples/submit-result.json`（两个用例的完整提交，合成数据）；运行输入见 `examples/start-run.json`；合成合约见 `examples/compile-contract.json`，合成台架见 `examples/bed-topology.json`。
7. 回答时照实转述 Hub 的每条结论：哪份用例的计划通过了哪些核对、哪份有哪条不通过（带上是哪一步、哪个参数或哪个地址），以及未知（例如有文档没读到、出件失败）。结论只说“按这份合约和台架清单核对通过/不通过”，不要写成“可以上机”。
