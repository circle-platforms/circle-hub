# 来源原件读取（source-read）

通用技能包 `source-read`：在任意工作中按系统包路由读取平台原件（缺陷、需求、构建、脑图文档、构建页、手册文件、SVN 文件）。

不绑定产品线，零要求项。`start_run` 时 Hub 按现有系统包连接器读取原件，返回来源引用（`src:<sha256>`）并触发喂入投影。投影可能在后台继续；是否完成、版本绑定和矛盾要以之后的喂入回执为准。

## 适用场景

当你在任何工作（如缺陷分析、用例复核、台架准备、构建核对等）中需要获取平台原件及其解析后的结构时，调用 `start_run` 启动 `source-read` 运行。

Hub 保证：
1. 真实系统仅只读访问，不执行任何写操作；
2. 捕获的内容存入内容可寻址不可变原件（`src:<sha256>`）；
3. 凭据只在密钥库中，永远不返回给模型；
4. 结构判定严格保真，未知诚实披露。

## 可选输入槽位

所有槽位均为可选输入（`required: false`），一次运行可指定一个或多个槽位：

| 输入槽位 | 说明 | 接受的外部对象格式 | 示例 |
| --- | --- | --- | --- |
| `defect` | PLM 缺陷记录详情 | `plm:bug` | `{"external": "plm:bug:57001"}` |
| `story` | PLM 需求记录详情 | `plm:story` | `{"external": "plm:story:20931"}` |
| `build` | PLM 产品构建列表 | `plm:builds` | `{"external": "plm:builds:101"}` |
| `mindmap` | 敏捷测试平台脑图文档 | `agile:mindmap` | `{"external": "agile:mindmap:880001"}` |
| `build_page` | 构建站页面或文件 | `buildsite:listing` / `buildsite:file` | `{"external": "buildsite:listing:rel_demo.html"}` |
| `manual_file` | 手册库或文档库文件 | `manual:file` / `openkm:file` | `{"external": "manual:file:cli.md"}` |
| `svn_file` | SVN 仓库只读文件 | `svn:file` | `{"external": "svn:file:17/path/to/file.txt"}` |

## 调用方法

### 1. 启动运行（start_run）

调用 Hub 工具 `start_run`，传入 `pack: "source-read"` 和所需读取的输入：

```json
{
  "pack": "source-read",
  "inputs": {
    "defect": {
      "external": "plm:bug:57001"
    }
  }
}
```

也可以在单次运行中同时读取多个来源：

```json
{
  "pack": "source-read",
  "inputs": {
    "defect": {
      "external": "plm:bug:57001"
    },
    "manual_file": {
      "external": "manual:file:guide.md"
    }
  }
}
```

### 2. 读取回答中的原件引用

`start_run` 成功返回后，结构化结果中包含：
- `run.sources`：已绑定来源数组，每个条目提供：
  - `reference`：原件引用，形如 `src:<sha256>`（或片段引用）；
  - `external`：规范化后的外部对象编号；
  - `role`：角色（`subject`）；
  - `media_type`：媒体类型；
  - `label`：来源名称或标题；
  - `coverage`：读取覆盖情况。
- `run.target_basis`：版本依据。
- `result`：零要求项的生产运行回执；它不等于喂入投影已完成，也不证明矛盾为零。
- `feeding_objects` / `feeding_pending`：已登记的引用和仍缺的事实及下一步。显示“投影进行中”时，不把空清单称为零个用例、未绑定或已完成；稍后用已有运行号和结果 `rec:` 查看状态，不重复发起读取。同一来源的相同缺失文案会去重，不能把文案里的数字相加当成受影响步骤总数；需要总数时按可读的逐条记录统计。未锁定命令树时命令身份未核对，不等于作者漏写命令。

### 3. 获取原件内容（get_nodes）

取得 `run.sources` 中的 `reference`（如 `src:<sha256>`）后，通过 `get_nodes` 读取完整原文或投影内容：

```json
{
  "reference": "src:<sha256>"
}
```

若原件内容较长，按 `get_nodes` 结尾提示的 `cursor` 逐页向后读取。

## 异常与出口

当输入无法正常读取时，Hub 诚实返回对应的拒绝或未知出口，不猜测、不伪造：

1. **编号不存在**：外部系统确认不存在该编号时，返回 `SOURCE_ABSENT` 或 `SOURCE_UNAVAILABLE`，指出缺席观察与下一步；
2. **路由未声明 / 类型不匹配**：给出的外部对象格式不在该输入槽位接受的类型列表中时，返回 `SUBMISSION_SCHEMA_VIOLATION`，列出受支持的类型；
3. **来源不可达**：网络中断、目标超时或系统暂时不可用时，返回 `SOURCE_UNAVAILABLE` 或 `SOURCE_RETRYABLE`，附带下一次允许重试的时间与补救建议；
4. **未提供任何输入**：未传入任何有效输入槽位时，返回 `source-read.no_source` 提示至少提供一个来源。
