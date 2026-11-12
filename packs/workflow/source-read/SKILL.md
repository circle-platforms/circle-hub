# 来源原件读取（source-read）

通用技能包 `source-read`：在任意工作中按系统包路由读取平台原件（缺陷、需求、构建、脑图文档、构建页、规格目录清单、手册文件、SVN 文件）。

不绑定产品线，零要求项。`start_run` 时 Hub 按现有系统包连接器读取原件，返回来源引用（`src:<sha256>`）并触发喂入投影。投影可能在后台继续；是否完成、版本绑定和矛盾要以之后的喂入回执为准。

## 适用场景

当你在任何工作（如缺陷分析、用例复核、自动化测试环境准备、构建核对等）中需要获取平台原件及其解析后的结构时，调用 `start_run` 启动 `source-read` 运行。

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
| `defect_list` | 按条件列出的 PLM 缺陷（条件 名=值 用 & 连接，名取 product、status、severity、assignedTo、openedBy、lastEditedDate_start、lastEditedDate_end；不分页，回答带条件和行数，空列表不说明没有） | `plm:bug-list` | `{"external": "plm:bug-list:assignedTo=alice&status=active"}` |
| `story` | PLM 需求记录详情 | `plm:story` | `{"external": "plm:story:20931"}` |
| `build` | PLM 产品构建列表 | `plm:builds` | `{"external": "plm:builds:101"}` |
| `mindmap` | 敏捷测试平台脑图文档 | `agile:mindmap` | `{"external": "agile:mindmap:880001"}` |
| `build_page` | 构建站页面或文件 | `buildsite:listing` / `buildsite:file` | `{"external": "buildsite:listing:rel_demo.html"}` |
| `spec_list` | 列出已配置规格目录的直接成员；只列清单，不选或读文件 | `manual:spec-list` | `{"external": "manual:spec-list:configured"}` |
| `manual_file` | 手册库或文档库文件 | `manual:file` / `openkm:file` | `{"external": "manual:file:cli.md"}` |
| `svn_file` | SVN 仓库只读文件 | `svn:file` | `{"external": "svn:file:17/path/to/file.txt"}` |

## 查找规格书：先清单，再显式读取

用户问“某个需求有没有规格书”时，需求记录附件为空、知识检索零命中都不能推出文档库没有原件。先从 `list_task_packs` 确认当前账号可用的工作流和输入声明；包列出了类型也不等于其资源已启用。只在已确认启用且当前账号获准的来源上调用；资源状态不明时说明尚未核实，并请资源管理员确认，不凭空推荐 `openkm:file` 或编造路径。手册库镜像可用不证明 OpenKM 可用。

1. 通过本工作流读取 `spec_list: {"external":"manual:spec-list:configured"}`。它只列资源管理员设置的 `spec_folders` 的直接成员，不使用关键词打分、不代替模型选择、不递归子目录、不读文件正文。没有目录设置时，请资源管理员配置后重读；这不是“没有规格书”。
2. 用本次运行的确切 `src:` 引用读取目录投影，核对 `folders`、`files`、`directories`、`unread`、`complete`。完整且空的清单只证明这些目录在这次观察中没有直接文件；子目录未展开、未读目录和其他来源仍未知。`complete: false` 不得当空清单或全库覆盖。
3. 客户端模型根据列表提出候选，使用列表中的准确 `path` 发起新的 `manual_file: {"external":"manual:file:<path>"}` 读取。只从文件名或显示标题不能确认它属于某需求；读取正文后按需求编号、标题及内容逐字证据核对，判断由模型给出并标注依据。Hub 不做语义匹配。
4. 回复分别交代实际读过的目录和候选、读取时刻/引用、无法核实的来源与可执行下一步。尚未读取的来源答“尚未检查”，不答“不存在”；被扣或不可用的原件也不能当成不存在。

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

1. **编号不存在**：外部系统确认不存在该编号时，运行照常成功：这条缺席观察（哪个系统、读于何时）绑定为这个输入的来源，回答在 `SOURCE_ABSENT` 缺口里写明下一步（同一个编号可能是这个系统的另一类对象）。缺口列出了这个工作流还能读的单个对象类型时，先用同一个编号读这些类型（比如缺陷里没有，就读同编号的需求），读到了就按读到的内容回答，并说明它不是用户说的那一类；都读过还没有，才告诉用户没有，不要把这一步留给用户；
2. **路由未声明 / 类型不匹配**：给出的外部对象格式不在该输入槽位接受的类型列表中时，返回 `SUBMISSION_SCHEMA_VIOLATION`，列出受支持的类型；
3. **来源不可达**：网络中断、目标超时或系统暂时不可用时，返回 `SOURCE_RETRYABLE`，附带下一次允许重试的时间与补救建议；
4. **没有读取权限**：对象存在而你没有读取权限时，返回 `SOURCE_NOT_PERMITTED`，修正写明谁能分享或分配；Hub 登录来源失败或过期、来源系统拒绝了 Hub 的账号、被扣的应答说明不了对象存在时，只返回中性的 `SOURCE_UNAVAILABLE`（对你不可用），原因只在管理员记录里，不要据此推断是你没有权限；
5. **内容待核看**：单个对象（比如一个缺陷、一个需求）的应答里有未核看的疑似凭据时，不给内容，也不说命中的是什么。手册、文件、构建页和列表被扣时说明不了对象存在，走上一条。只读的工作流把这条观察绑定进运行，运行照常结束，缺口写 `SOURCE_PENDING_REVIEW`，读取覆盖标“部分”。这不是读取失败：告诉用户这个对象存在、内容待核看，下一步到来源系统看原文，管理员核看后再重读，不要换别的方式重读；
6. **未提供任何输入**：未传入任何有效输入槽位时，返回 `source-read.no_source` 提示至少提供一个来源。
