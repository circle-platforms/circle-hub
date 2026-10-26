# ORBIT 7.1 命令行手册（合成）

# 信标配置

**orbit beacon add** *\<ring\> \<address\> \<port\> \[weight\]*

该命令用于向环添加信标。\u0000\u0000

|         |                                    |
|---------|------------------------------------|
| ring    | 该参数指定环的名称，长度 1–32。     |
| address | 该参数指定信标的地址。             |
| port    | 该参数指定信标的端口。             |
| weight  | 可选。该参数指定权重，取值 1 到 100，默认值为 10。 |

示例：

    Box(config)#orbit beacon add r1 192.0.2.5 8080 20

**orbit mode** *\<mode\>*\u0000

该命令用于设置环的分配方式，取值 rr、lc 或 hash，默认 rr。

# 显示命令

**show orbit status** *\[ring\]*

该命令用于显示环的状态；不给环名时显示全部环。
