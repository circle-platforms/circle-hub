---
name: operation-capture
description: 在用户明确开启共享的 Circle 会话里，由工具后钩子脱敏、保存并自动上传完整工具输出，再把模型提炼的观察、步骤或教训带逐字引文交回注运行。用于沉淀做过的操作；不用于生成事实、推断版本或采集未开启共享的会话。
---

# 操作采集与整合

本技能目前只支持 macOS 和 Linux：Circle Hub 及其任务包暂不支持 Windows，在 Windows 上命令直接报错，钩子不采集。

先用 `/skill operation-capture` 加载本技能；只安装或只读 SKILL.md 不会启动钩子。共享默认关闭，每个会话单独开启。技能不读 Circle 密钥库、环境密钥或真实配置，不上传人的说法、模型转述或其他工具原文。

## 1. 用户开启本会话

用户先准备仅供采集使用的 Hub 令牌文件：一行令牌、普通单链接文件、权限 0600。令牌不写在命令、提案或仓库里。用 `/session` 查会话号，然后由用户确认执行：

```sh
node <技能目录>/operation.ts enable --session <会话号> --hub <Hub MCP 地址> --token-file <令牌文件>
```

明文 HTTP 只许本机回环假 Hub。状态保存在 Circle home 的 `operation-capture/` 下，不写工作区。`CIRCLE_HOME` 未设置时按 Circle 默认 home；去空白、`~` 展开和 realpath 与 Circle 一致。技能须安装在该 home 的 `skills/operation-capture/`，因为 Circle 不向钩子提供技能目录。

开启后，`after_tool` 钩子自动把工具输出和当前 Hub 令牌的字面出现脱敏、保存完整 UTF-8 原件、追加 SHA-256 哈希链清单并直传 Hub，出处为 `client_captured`。钩子显式传递 `captured_at`；旧客户端缺这个声明时记录仍保留，视图注明采集时间未声明，上传时刻不当作采集时刻。模型不参与采集或上传。不能完整脱敏、扫描不完整、Unicode 不良或超限时整条不采，不截断。钩子对模型静默；错误只在本地日志写结构错误码。网络结果未知不等于未上传，重试依靠幂等上传。

随时核对或停止：

```sh
node <技能目录>/operation.ts status --session <会话号>
node <技能目录>/operation.ts verify --session <会话号>
node <技能目录>/operation.ts flush --session <会话号>
node <技能目录>/operation.ts recover --session <会话号>
node <技能目录>/operation.ts disable --session <会话号>
```

`disable` 会等待进行中的采集、上传或整合完成，返回后不再执行这些动作；待传记录只有重新开启后才重试。`recover` 把未登记输出和不完整清单尾部移到本地 `recovery/` 并显示数量，这些无法证明完整的片段只保全、不上传。清单被改、原件被改或有未登记文件时先运行它核查，不能自动重建链掩盖变化。能重写整个状态目录并重算全部摘要的人可伪造自洽链，本技能没有外部信任锚。

## 2. 读取已上传原件

`list` 只列元数据、摘要和上传引用；`read` 才输出本地原件，且该原件必须已有上传回执：

```sh
node <技能目录>/operation.ts list --session <会话号>
node <技能目录>/operation.ts read --session <会话号> --sha <原件 SHA-256>
```

只从 `read` 的实际字节逐字抄引文，不从会话转述抄。每条整合记录只引一份原件；步骤涉及多份原件时拆成多条。

## 3. 模型只写三类提案

写一个普通 JSON 文件，结构如下。`kind` 只能是 `observation`、`procedure`、`pitfall`，其他内容不提交。`session` 与开启共享的会话相同，`capture` 是已上传原件摘要，`path` 从 Hub 知识树复制。每条可写 `device` 和 `bed`，只是客户端声明，只收字符串；省略时分别沿用采集清单的 `targets.device` / `device_id`、`targets.bed` / `bed_id`，不得冲突，声明床必须同时有设备。运行或它接续的预订冻结了台架清单时，Hub 按清单核对；只有一个台架含该设备时补上台架，同名设备在几个台架里就写明 `bed`。记录只写设备和台架，不写租约。提案任何文字都不得含当前 Hub 令牌，含了就在开运行前被拒。单份采集会自动带上 `upload.source.artifact`；同字节有多份采集时必须在条目里另写 `artifact`，从 `list` 选本次原件。旧清单缺这个字段时须重新采集上传，不按字节或顺序猜采集时刻。

- observation：`statement`、`action`、`quote`；quote 为 `{line: 行号, text: 逐字引文}`。
- procedure：`statement`、`goal`、`steps`；每步为 `{text: 步骤, quote: {line, text}}`。
- pitfall：`statement`、`phenomenon`、`suggestion`、`quote`。

```json
{
  "schema": "operation-integration@1",
  "session": "circle-synthetic",
  "items": [
    {
      "capture": "<64 位原件摘要>",
      "kind": "observation",
      "path": "/commands/system/show",
      "statement": "核对了 ORBIT 合成状态",
      "action": "执行合成状态检查",
      "quote": { "line": 1, "text": "ORBIT synthetic status: ready" }
    }
  ]
}
```

不要写 `object`、`binding`、`by`、`run`、`at`、`lease`、`version`、`build`、`line` 或任何产品版本声明。不要改写引文的空白、大小写、标点、字符宽度或 Unicode 形式；改一个字就会在本地或 Hub 边界被拒。

## 4. 开独立回注运行并提交

产品由操作者选择；只有操作者已给构建目标时才加 `--build`，它只用于 `start_run` 锁定，绝不写进提案或回注条目。`--model` 是当前整合模型的确切身份，不是产品版本。

```sh
node <技能目录>/operation.ts submit --session <会话号> --proposals <提案.json> --product <产品> [--build <操作者给定构建>] --model <整合模型身份>
```

脚本核验整份清单和全部引文，上传普通工作清单，开 `knowledge-contribution` 回注运行，再从运行回答取 `product/root` 形成 `code=assertion` 和对应的 `fed-*@1` 结构。Hub 自己填写版本、对象、上传者和时间。未受理时按原回执修正，退出码非零；不得把未入层条目说成已回注。回执追加保留，不覆盖。
