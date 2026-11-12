# 独立表格取值执行器

这一目录是执行器侧的自有组件，不是 Hub 运行依赖，也不写入中性的 bed-install 包。组件使用原设备工厂和普通执行步骤，在每条用例内增加 `table_cell`；原共用文件和原 `case_submit` 不改。

## 取一格

接口为 `table_cell(output, *conditions, separator, columns, column, format='delimited', header=0, row=0)`，返回单格原样文字。条件是可读的位置参数 `where N=VALUE`，多项全部精确相等。行序号与条件二选一，列序号从1起。

分隔表只接收按声明字面分隔符拆出指定列数的行；键值行只接收含分隔符的行，并在第一处分成两列。表头是第一条符合形状的行。空白行跳过，其他行不按内容识别；单列整行模式不能另外辨别提示符。

G 使用原参数语法，例如 `{},where 1=sample,where 2=public,column=3,columns=3,header=0,separator=+`。纯数字条件值留在位置字符串中，所以 `where 3=00123` 不会变成整数。G 不使用 JSON、base64 或新的转义。

列不存在、没有符合形状的行、零行或多行匹配都会以“取不到”失败，附位置与设备原话。异常终止本条后续步骤；原框架的收尾仍由原 fixture 处理，不根据文字猜哪些 Excel 行是清理。

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

`--object` 可以重复。导出先让原入口核对它实际加载的原规则，再加载原 fixture，收集实际加载的框架源文件、原规则登记的源文件及本组件发布文件，读取这些字节重算身份。保留原动作状态，不生成设备认证回执，也不沿用原规则的身份。新增方法的 `parameter_roles` 来自本组件的明确声明；Hub 的类型化附加说明仍须对应新原件，不由这里伪造。

原规则的设备对象、方法、动作和原来源资料保留。新增条目是每个指定对象的 `table_cell`，输出为单格；Hub 的 `block_model.cell_methods`、`cell_inputs` 和 `cell_text` 是发布附加说明，不混入原格式文件。新规则 `source_hashes` 中 `cell-runtime/` 指本组件，其余相对路径指原框架根。

再从实际写出的新原件和对应的旧 Hub 声明生成新声明：

```sh
python entry.py export-hub-contract --original <新原格式规则> --base-hub-contract <对应旧Hub规则> --out <新Hub规则>
```

此步骤验证旧声明恢复出的原始身份与新入口记录的基础身份一致；只有签名、来源位置和源字节未变的方法才继承旧的类型化声明。新取格方法的 `parameter_types`、`parameter_roles`、`cell_effect` 来自新原件中的本组件声明；角色为 `cell_source` 和 `cell_selection`，不冒充断言、自动结果或等待。纯数据调用预算沿用每条用例既有256块上限，不写成零次调用。附加说明的来源引用指向新原件实际写入字节，部署应把原件作为可解析的来源一起存入Hub。

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

新工具先沿原任务流程保存原字节 Excel，再在本任务目录放自己的逐行入口、规则和路径说明；不动框架目录中的共用文件。原启动函数仍接管床锁、任务存活锁、状态及结果文件。新工具单独把工作簿标记核对绑定到新规则，原工具的标记值不变。

本地只用合成框架、网关和设备测试，不导入真实参考模块，不读取真实配置或 home，不请求设备。合成测试不是部署、原框架运行或设备效果的证明。
