# bed-install 1.0.4

给整台预订的自动化测试环境装构建（决定 117）。照部署的测试框架做：升级就是框架里的普通用例，清单里第 i 台派发目标设备
一个；用例从镜像文件名推出目标构建，设备已是目标构建就跳过，否则放镜像、更新设备、等它重启、升级后核对版本。装构建执行器
原样把这些用例交给自动化测试环境，请求协议、恢复和结果读取与用例执行器相同。

不生成内容，不调用模型。

## 部署数据（1.0.4，决定 144）

包本身是中性的：不写任何测试框架的用例号、文件路径、镜像扩展名、执行器的收尾标记或网关的工具名。这些值是部署数据，
走 main 已有的两条路：

| 值 | 放在哪里 | 谁写，怎么写 |
| --- | --- | --- |
| 升级用例号（按清单里派发目标设备的顺序） | 命名文档 `bed-install-profile` 的 `upgrade_cases`（形状 `bed-install-profile@1`） | 管理员：`circle-hub doc put bed-install-profile <文件>` |
| 升级用例认的镜像扩展名 | 同一份命名文档的 `image_extensions` | 同上 |
| 收尾标记（每个升级用例收尾都写的那一行的字面） | 装构建执行器定义的 `result.closing_marker` | 集成者：`circle-hub executor add <文件>` / `update <编号> <文件>` |
| 网关的装构建工具名、参数、结果字段 | 同一份执行器定义的 `calls`、`receipt`、`result` | 同上 |

为什么是命名文档：test-bed 和 case-compile 的自动化测试环境清单（`bed-topology`）、case-compile 的运行器合约
（`runner-contract`）和运行环境配置（`runtime-profile`）都是这样给真实值的：管理员发布，运行按摘要冻结，检查只从冻结的
字节重算。别的路都不合适：包函数看不到执行器定义，执行器定义里的变量（`${var:名字}`）只准用在 `target`、`manifest_sha256`
和条件的期望值上；产品包声明（`product.json`）没有让工作流包读取的通道；`CIRCLE_HUB_*` 只是进程配置。收尾标记本来就只由
执行器定义给（`hub/dispatch/README.md`：目标的命令和收尾标记都来自部署的执行器定义），包不读它，所以不进档案。

镜像角色：famx 的资产语法 `famx-assets@2` 已经把 `<前缀>-<构建名>.<扩展名>` 认作镜像，但运行上下文里没有让工作流包按
产品的资产语法核对文件名的通道（只有产品名、构建、租约和命令策略），加一个就是新的核心机制，本版不加。所以档案写升级
用例认的扩展名；取值应是产品资产语法认作镜像的扩展名里升级用例真能处理的那些。`functions/profile.test.ts` 用 famx 的
`parseListing`（经它的 `api.ts`）核对合成档案的每个扩展名在 famx 的列表页上都被认作镜像。

### 档案的形状 bed-install-profile@1

```json
{
  "schema": "bed-install-profile@1",
  "upgrade_cases": ["<第 1 台派发目标设备的升级用例号>", "<第 2 台的>", "…"],
  "image_extensions": ["<不带点的扩展名>", "…"]
}
```

只有这三项。用例号是字母、数字和 `. _ : -`，至多 200 字；扩展名是字母和数字，至多 16 字；两列都不能空、不能重复。合成
示例是 `examples/bed-install-profile.json`（main 的测试和验收都用它）。真实值不在本仓库。

### 缺了怎么办

每种缺口都写明缺的是什么、谁做下一步：

- Hub 里没有这份命名文档：开运行时 Hub 自己拒绝（`SOURCE_ABSENT`，下一步是管理员用 `circle-hub doc put` 发布）。
- 槽没有绑定或读不出内容：`bed-install.no_profile`，写明要在 `inputs.profile` 写什么、管理员用哪条命令发布。
- 形状不对：`bed-install.profile_invalid`，逐项列出哪个字段缺了、多了或不合规则，下一步管理员改好重新发布。
- 升级用例比派发目标设备少：`bed-install.too_many_targets`，写明差几个，下一步管理员补齐后重新发布。
- 镜像扩展名不在档案里：检查 `install` 拒收（`bed-install.request_invalid`），写明档案认哪些扩展名、镜像名该从哪里取。

## 流程

1. test-bed 整台预订；本包的运行以那次预订为前驱。
2. 客户端写并上传装构建请求 `{"schema":"bed-install@1","build":…,"image":…}`（待核验产物槽 `request`）。
3. 开运行时 product 和 build 写设备现在装的构建：派发前的逐座位版本探针按它核对设备，没对上就不派发。inputs 写清单
   （`doc:doc:bed-topology`）、档案（`doc:doc:bed-install-profile`）和请求的引用。
4. 投影：清单里该环境类型在 `policies/install.json` 的 `device_types` 里的设备（清单顺序）各一个条目，条目号是档案
   `upgrade_cases` 里同位置的升级用例。冻结分组带环境、全部设备、派发目标、清单/档案/请求三个摘要、本环境用到的升级
   用例、档案的扩展名和请求原样。
5. 提交：每个条目一份 `reason`（data.build，grounds 是依据）。
6. 检查 `install`：请求只有三项；镜像名以档案里的扩展名结尾，按升级用例的读法（第一个 `-` 之后到最后一个 `.` 之前，`_`
   读作 `.`）正是 build；reason 写同一个构建；前驱在开运行时的租约视图里持有 `bed/<环境>/<每台设备>`；运行锁定了构建。
   支持事实带执行器绑定的派发参数（请求摘要、升级用例、环境、清单摘要、锁定构建、前驱），依据引用请求、清单条目和档案。
   `dispatch_policy` 是同一检查加参数表，受理时和写意图前各跑一次。
7. 效果行 `install_build`：放行要求 reason 和 install，由登记了 `proof.package = bed-install` 的执行器派发。

## 执行器（集成者登记，不在本包）

装构建执行器的提交调用网关的装构建工具（工具名和参数写在定义的 `calls.submit`，内容参数绑定 `payload_base64`）；proof
写 `package: bed-install`、`requirement: install`、`slot: request`、`warrant_id: bed-install.install@<本包版本>`，所以本包
升版后 `warrant_id` 要跟着改。结果的条目号是升级用例号；`result.closing_marker` 写测试框架每个升级用例收尾都写的那一行
的字面（核心在本次日志里逐字查它）。资源键与用例执行器相同，所以两者不会同时占床。不声明床面快照：装构建本来就会改变
设备。

## 版本

- 1.0.1：复现缺陷要在发现它的构建上跑，环境装的不是它时先装、不问用户；镜像文件名的出处（构建站入口页 → 版本线导航页 →
  列表页条目的镜像链接）写进包说明、请求槽说明、SKILL 和拒收文字。
- 1.0.2：同一份字节 Hub 只派发一次（V07），装失败后要再装就得是新的请求，请求加可选的 attempt（第几次）。
- 1.0.3（决定 119）：没过的升级用例照 case-compile 第 9 步归因，说得出这次和上次哪里不同才带 attempt 再装，说不出交用户
  决定；装构建和随后的用例沿用同一个预订，不接着跑用例时作业有终态后释放。
- 1.0.1–1.0.3 只在私有集成线上发布过，包里带着测试框架的真实值。
- 1.0.4（决定 144）：进 main。升级用例号和镜像扩展名移进装构建档案（新输入槽 `profile`，拒收码 `bed-install.no_profile`、
  `bed-install.profile_invalid`），收尾标记只在执行器定义里；表改为 `bed-install.install@2`（去掉 cases、image_extensions，
  加 `profile_schema`）；新增反例 `install-image-extension`。生产上已发布的 1.0.3 照常可用；切到 1.0.4 之前管理员先发布
  档案，并把装构建执行器的 `proof.warrant_id` 改为 `bed-install.install@1.0.4`，否则受理后的派发找不到指定核验函数的
  事实。执行器改成 1.0.4 以后，1.0.3 开的运行受理后也不再派发（指定的核验函数不同）：还没派发的装构建用 1.0.4 重开运行。

## 限制

- 条目与设备的对应按清单里派发目标的顺序，假定它就是测试框架配置里的设备顺序（执行器的探测座位按同一顺序登记）。
- 不核对构建库里有没有这个镜像，也不核对设备装不装得上：以作业结果为准。
- 档案的扩展名是否真是产品资产语法认作镜像的扩展名，只在测试里对合成档案核对；运行时只按档案核对。
- 装构建之后，用例执行器的床面基线若因设备重装而不同，派发前的残留检查会列出差异和出口。

## 测试

```sh
node packs/workflow/bed-install/pack-files.ts --check
node --test "packs/workflow/bed-install/**/*.test.ts"
node --test tests/acceptance/58-bed-install.test.ts
```

`pack.test.ts` 的已暂存包校验和 `publish.test.ts`、验收 58 要操作系统隔离（沙箱），没有时跳过。
