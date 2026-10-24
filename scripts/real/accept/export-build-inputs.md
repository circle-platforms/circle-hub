# 构建验收输入导出

由集成者在部署主机运行。开发和测试只用合成数据，不会启动同步、模型、派发或连接真实业务系统。先让管理员完成知识生产和原件读取，再导出已保存的快照。

```sh
node scripts/real/accept/export-build-inputs.ts \
  --token-file <管理员令牌文件> \
  --product <产品> --build <构建> \
  --out <仓库外空目录> [--url <MCP地址>]
```

令牌文件按 `hub-call.ts` 的方式以 UTF-8 读取并去掉首尾空白；令牌不进入命令行、输出或证据文件。管理员 CLI 使用 `bin/circle-hub`，仅给该子进程设置 `CIRCLE_HUB_TOKEN`。它使用部署主机的现有数据库配置；`--url` 只指定同一个 Hub 的 MCP 地址，默认与 `hub-call.ts` 相同。不要把 URL 指向另一套部署。

读取路线：新增的通用只读命令 `circle-hub knowledge view <knowledge外部标识> [--only <取值列表>] --out <新文件>` 调用现有知识视图读取器，保留它的 JSON 字节。单独的 --only 使用与引用查询参数相同的逗号分隔、URI 百分号编码写法，不能与引用内的 only 重复。屏幕仅输出字节数、SHA-256、totals 数字计数和截断/跳过情况。它只允许启用中的管理员，不加 MCP 工具，不借用业务包创建运行，也不生产知识。普通 `knowledge sync` 没有被调用。视图读取会保留现有的读取凭据和派生记录。

导出索引是 `knowledge:index:<产品>:<构建>?kind=case&key=document&fields=commands,document,node`。完整视图保存为 `index-1.json`；超过视图字节预算时，脚本通过 MCP `get_nodes` 逐页遍历锁定的构建根及无版本根，发现完整文档键，再逐文档用 `only=` 补取，保存为 `index-*.json`。所有分片必须保持同一产品、构建根、无版本根和总条目数。单文档超过索引单键上限、来源未读、扫描排除或快照漂移均拒绝，不把截断的发现视图混进可供比较的索引文件。

文档原件用 `original list --external agile:case:<文档>` 查找，再严格比较完整标识，只取最新记录，使用 `original export` 导出为顺序编号的 `original-map-*.json`。命令树按 `buildsite:file:` 和 `/command_tree-<构建>.xml` 后缀定位。新增的通用 `original list --suffix` 在数量上限之前筛选，避免其他构建的原件占满列表；多个不同路径匹配同名命令树时拒绝猜选。每份原件导出后重新核对字节数和 SHA-256。

输出目录必须在所有 Git 仓库之外且为空，父路径经真实路径核对。文件权限为 0600，新建目录为 0700，不覆盖既有文件。产物：

- `index-*.json`：直接供 `command-index.ts --index` 使用，每份各给一次参数。
- `original-map-*.json`：平台回答的原件字节，摘要和 CLI 导出一致。若回答含 `data` JSON 字符串，确定性解码为 UTF-8，另存 `map-*.json`；若原件本身已含顶层 `root`，两份字节一致。解码后必须含脑图 `root`，不改写节点或数值文字。屏幕分别给原件和解码文件的摘要。
- `map-*.json` 和 `maps.txt`：清单每行是原件绝对路径和文档编号，以冒号分隔，直接供 `case-commands.ts --maps` 使用。
- `command-tree.xml`：直接供 `case-commands.ts --tree` 使用，保持原字节及编码。

屏幕只输出计数、字节数、SHA-256，以及固定的缺失事实和下一步，不输出编号、标题、原件内容、子命令原始输出或异常消息。任一输入不完整或原件缺失均非零退出。失败时目录可能留有部分证据，不能作为完整输入使用；按报出的下一步修正后换空目录重跑。零文档索引可导出，但 `case-commands.ts` 本身要求至少一份脑图；该情况不能用于它的用例抽取验收。
