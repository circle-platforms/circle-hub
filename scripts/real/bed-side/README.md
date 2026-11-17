# 独立表格取值执行器

这一目录是执行器侧的自有组件，不是 Hub 运行依赖，也不写入中性的 bed-install 包。组件使用原设备工厂和普通执行步骤，在每条用例内增加 `table_cell`；原共用文件和原 `case_submit` 不改。

## 取一格

接口为 `table_cell(output, *conditions, separator, columns, column, format='delimited', header=0, row=0)`，返回单格原样文字。条件是可读的位置参数 `where N=VALUE`，多项全部精确相等。行序号与条件二选一，列序号从1起。

分隔表只接收按声明字面分隔符拆出指定列数的行；键值行只接收含分隔符的行，并在第一处分成两列。表头是第一条符合形状的行。空白行跳过，其他行不按内容识别；单列整行模式不能另外辨别提示符。

G 使用原参数语法，例如 `{},where 1=sample,where 2=public,column=3,columns=3,header=0,separator=+`。纯数字条件值留在位置字符串中，所以 `where 3=00123` 不会变成整数。G 不使用 JSON、base64 或新的转义。

列不存在、没有符合形状的行、零行或多行匹配都会以“取不到”失败，附位置与设备原话。异常终止本条后续步骤；原框架的收尾仍由原 fixture 处理，不根据文字猜哪些 Excel 行是清理。

读出单格还须满足原规则 `entries[].cell_effect.value_policy` 的声明：当前 `ascii-cell-value@1` 允许ASCII字母、数字和 `. _ + : -`，长度1到128。运行按已核来源绑定的声明检查，不接受调用参数覆盖；空白、控制字符、引号及其它未允许符号会在回填下一条命令之前失败，说明字符类别/位置，不执行后续命令。整段设备原文和筛选条件不受这项返回值限制。

取名字的一段：设备生成的只是名字的一段时（例：200 字符域名的密钥文件名 `K<域名>.+005+<编号>+ksk+RSASHA1+1024.key`，设备只生成 5 个字符的编号），取出的单格就是这一段，名字里已知的各段写在用它的命令里，运行器把单格整段替换进 `{}`：G 写 `{},where 1=K<域名>.,where 2=005,where 4=ksk,where 5=RSASHA1,where 6=1024.key,column=3,columns=6,format=delimited,header=0,row=0,separator=+`，用它的命令写 `sdns dnssec keypub "<域名>" "ksk" "K<域名>.+005+{}+ksk+RSASHA1+1024"`，替换后是 229 字符的名字。1 到 128 个字符的值策略只管取出的单格（这里是编号），不管替换后的整条命令（替换不限长度，InfoTest `lib/test_xlsx.py:662-669`）；已知各列的 `where` 同时核对命令里写死的段与设备实际打印的是否一致，不一致取不到，不会把编号填进对不上的名字；同域名留着第二把同类密钥时选中2行，也停下并附设备原话。整行当一格（分隔符空、1 列）取这样的名字会因为超过 128 个字符被拒，且回显和提示符也算行，不是取名字的写法。`table-cell.test.ts` 用这个设备形状（回显、每把密钥 `.key` 与 `.private` 两行、提示符、别的域名的残留行）验证。

## 文件与运行

- `table_cell.py`：纯取格函数及它声明的参数角色。
- `cell_runtime.py`：规则导出、加载文件核对和本次设备装配。普通方法委托原设备，取格方法只读传入文字。
- `test_xlsx.py`：本条用例自己的 pytest 入口。调用原逐行函数的独立全局字典，私有规则加载不修改原模块或源文件。
- `cell_gateway.py`：同原协议增加 `case_submit_cell`。租约、任务记录、启动和轮询沿用原网关；只有新工具使用私有暂存入口与新规则标记。原工具仍用原标记。
- `entry.py`：以下命令入口。执行框架用原 Python 解释器；MCP 服务用原网关 Python 环境。

先在实际执行器中按本次加载的源码导出**新的原格式规则**：

```sh
python entry.py export-contract --framework-root <原框架目录> --base-contract <原框架规则> --object <对象名> --out <新规则文件>
```

`--object` 可以重复。导出只读取原框架 `lib/excel_contract.json`、指定原规则及其声明的来源字节，不导入框架入口、fixture 或网关模块。两份规则内容、规范摘要、入口摘要及每个来源摘要须对应，入口和设备工厂的来源声明缺失时拒绝；追加本组件的五文件摘要后生成新身份。这不代替执行时原框架的形状/版本检查，也不生成设备认证回执。保留原动作状态，不沿用原规则的身份。新增方法的 `parameter_roles` 来自本组件的明确声明；Hub 的类型化附加说明仍须对应新原件，不由这里伪造。

原规则的设备对象、方法、动作和原来源资料保留。新增条目是每个指定对象的 `table_cell`，输出为单格；Hub 的 `block_model.cell_methods`、`cell_inputs` 和 `cell_text` 是发布附加说明，不混入原格式文件。新规则 `source_hashes` 中 `cell-runtime/` 指本组件，其余相对路径指原框架根。

再从实际写出的新原件和对应的旧 Hub 声明生成新声明：

```sh
python entry.py export-hub-contract --original <新原格式规则> --base-hub-contract <对应旧Hub规则> --out <新Hub规则>
```

此步骤验证旧声明恢复出的原始身份与新入口记录的基础身份一致；只有签名、来源位置和源字节未变的方法才继承旧的类型化声明。新取格方法的 `parameter_types`、`parameter_roles`、`cell_effect` 来自新原件中的本组件声明；角色为 `cell_source` 和 `cell_selection`，不冒充断言、自动结果或等待。纯数据调用预算沿用每条用例既有256块上限，不写成零次调用。附加说明的来源引用指向新原件实际写入字节，部署应把原件作为可解析的来源一起存入Hub。

`export-hub-contract` 也只读 JSON，不导入框架或网关模块。任务里的 `test_xlsx.py` 是薄入口，不是复制整份原逐行实现；运行时加载原 `lib/test_xlsx.py`，复制其函数的全局字典并替换规则读取，再通过设备代理提供取格。服务启动构造私有网关及每次任务运行前都核对规则声明的来源摘要；原框架或组件变动会被拒绝，不会无声沿用旧身份。启动后发生变动不会由后台轮询自动发现，但任务构造仍重核。规则没有声明的来源不在该完整性保证范围内。

已有独立政策来源保留原引用及摘要，不伪称它们由新入口加载。已登记在源码表中的政策来源若字节变了，则不继承该项；旧共用政策不会仅因本来不属于框架源码表就被删除。

发布给 Hub 的是新 `runtime-contract@2`，交给私有执行入口的是新原格式规则。去除新增声明可恢复原件的规范身份，`original.sha256` 是那份原件实际字节的摘要；不从旧文件手换摘要或制造设备认证回执。

独立运行某个已生成的 Excel：

```sh
python entry.py run --framework-root <原框架目录> --contract <新原格式规则> --xlsx <本次Excel> -- --build <构建名>
```

在跳板机启动自有 MCP 入口，用原配置保留 TLS、授权和状态目录：

```sh
python3 entry.py serve --gateway-root <原网关源码目录> --config <原网关配置文件> --contract <新原格式规则>
```

服务仍提供原 `/mcp` 协议，工具列表多一个 `case_submit_cell`。新执行器定义只将提交工具指向它；其他工具和原工具行为保留。服务启动入口需要由部署者切换，单独复制 runner 文件不会让旧 `case_submit` 自动走新代码。

新组件规则缺失、来源不符等检查失败时，服务降级只提供原工具，标准错误及审计记录原因。自己的 `runtime/status.json` 记录 `mode`（`cell`或`original`）、原因、UTC时间和PID；安装器的status/观测只把对应当前MainPID的状态当作当前状态，缺失/陈旧不算已启用取值。安装装后核对要求 `cell`，降级会触发撤回；日常重启降级不会为此关闭原工具。

新工具先沿原任务流程保存原字节 Excel，再在本任务目录放自己的逐行入口、规则和路径说明；不动框架目录中的共用文件。原启动函数仍接管床锁、任务存活锁、状态及结果文件。新工具单独把工作簿标记核对绑定到新规则，原工具的标记值不变。

路线审计在转交前记 `cell_route_requested`，分配任务号、暂存之前记 `cell_route_task`，返回时记 `cell_route_result` 的实际task_id/ok/replayed；分配不等于已创建或启动，重放不冒充新任务。任务里的 `cell-runtime.json` 另含 `submission_tool=case_submit_cell` 及组件/框架根。旧工具的请求日志含义不改，旧路不写这份组件标记。

本地只用合成框架、网关和设备测试，不导入真实参考模块，不读取真实配置或 home，不请求设备。合成测试不是部署、原框架运行或设备效果的证明。

## 0.4.7 startup alignment

The private service now follows the original gateway startup order: configuration/journal error handling (exit 2), pending request-audit flush, server construction, the original listening notice, serving, KeyboardInterrupt handling, and final server close. The entry propagates the service exit status. Original tools and unknown names still delegate to the original gateway; only case_submit_cell selects the private staging and contract.

The synthetic lifecycle tests construct in-memory gateway modules and no listener. They cover audit ordering/rows, config and journal errors, normal/TLS notices, interrupt cleanup, audit failure, and the real entry main guard. These checks do not load the actual gateway, framework, configuration or devices and do not establish deployment or in-flight switching safety. Install/rollback drafts are reviewed separately and are not executed by these tests.
