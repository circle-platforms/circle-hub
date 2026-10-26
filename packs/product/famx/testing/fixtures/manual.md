# 引言

本手册是为测试编写的合成命令行手册，所有命令都是虚构的。

调度算法见 `demo pool mode` 命令。

# 基本配置

本章介绍虚构的 demo 命令，包括：

- 成员池配置

- 静态路由配置

**?**

该命令用于显示当前级别下可以使用的命令。

**demo pool add** *\<pool_name\> \<member_ip\> \[weight\]*

该命令用于向成员池添加成员。

|           |                                      |
|-----------|--------------------------------------|
| pool_name | 该参数指定成员池的名称，长度 1–32。 |
| member_ip | 该参数指定成员的地址。               |
| weight    | 可选。该参数指定权重，默认值为 10。 |

> [!NOTE]
> **注意：**
>
> 添加成员前请先执行“**demo pool create**”命令。

**demo pool mode {rr\|lc\|hash}** *\<pool_name\>*

该命令用于设置成员池的调度算法。

**\[no\] demo route static** *\<network\> \<netmask\|prefix\> \<gateway\>* **{permanent\|temporary}** *\[metric\]*

该命令用于添加或删除静态路由。

示例：

    Box(config)#demo route static 192.0.2.0 255.255.255.0 192.0.2.1 permanent

**注意：** 修改路由会立即生效。

**demo probe** *\<name\>* **{tcp\|udp}** *\[\<port\>\]\[\<timeout\>\]*

该命令用于配置探测。

**enable** *\[recovery\]*

**enable** 命令用于进入 Enable 级别，这一段是正文而不是命令锚点。

## 显示命令

### **show demo status** *\[pool_name\]*

该命令用于显示 demo 的状态。

<!-- -->

<table>
<colgroup>
<col style="width: 30%" />
<col style="width: 70%" />
</colgroup>
<tbody>
<tr class="odd">
<td>pool_name</td>
<td>可选。该参数指定成员池的名称。</td>
</tr>
</tbody>
</table>

### 其他说明

这一节没有命令锚点，内容挂到它自己的章节节点。

**demo broken** *\<name*

这一行的参数括号不完整。

---

**demo pool add** *\<pool_name\> \<member_host\>*

同一个命令的另一种写法。

# 合成适用范围：装有 Card-A 时

装有 Card-A 时。内存至少8GB。需要 Permit-A 许可。适用于 Form-A 部署形态。

## 合成子节

合成条件下的普通说明。
