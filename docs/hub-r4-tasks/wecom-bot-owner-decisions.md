# 待 owner 决策：企微智能机器人接入 Hub（功能清点与决策草案）

草案页，供 integrator 审阅后把"二、决策条目"并入 `docs/hub-r4-progress.md`。清点来源：对 owner 主机上既有企微智能机器人项目的**只读源码审阅**（2026-11-02；未执行其任何代码，未读其环境文件——下面出现的都是环境变量名与代码文件名，无值、无路径、无凭据）。配套事实记录在 `packs/system/wecom-robot/README.md`。

## 一、功能清点（全量，按通道分组）

| 号 | 功能（机器人现状） | 证据（文件:行） | r4 归属 | 缺口/动作 |
| --- | --- | --- | --- | --- |
| A1 | WebSocket 长连接：Bot ID+Secret+网关 URL，SDK 管鉴权/心跳/重连 | main.py 全篇；gateway.py:909-966 | 宿主侧（R03 运行宿主），不是 Hub 路由 | 无 Hub 改动 |
| A2 | GET gettoken（corpid+corpsecret 走查询参数）换 access_token | gateway.py:738-762 | 系统包登录形态 | connectors 需支持查询参数登录与查询参数令牌（README Need 1）|
| A3 | GET user get（token 在查询参数）解析加密外部联系人（wm/wo/wp 前缀）姓名 | gateway.py:763-812 | 系统包读 wecom:user（本包已声明，auth 形状待按 A2 改） | 决策 D1 |
| B1 | 入站 text/mixed（文本段合并）| inbound.py extract_text | 事件是提示（D01 R[3]）→ 收后重读对象、先落库再处理 | 宿主侧，接 Hub 后落 upload_file/start_run |
| B2 | 入站 file/image/voice/video：url+aeskey 客户端 AES 解密；512KB 分片；5B–100MB 校验；同名冲突加随机后缀；文件名取 Content-Disposition | inbound.py:29；files.py:21-72 | 附件=源文件（upload_file→B03 源文件+读清单）；"超大报错不截断"与 Hub 读规则同构（D01 R[2]） | 宿主侧调用，无核心改动 |
| B3 | enter_chat → 欢迎语 | gateway.py:977-988 | 宿主侧体验 | 记录即可 |
| B4 | 命令词：停止/终止/强制终止、/stop//kill//abort；新对话/新会话/重置、/new//reset；帮助；报告、/report | inbound.py:16-19 | 停止=取消宿主任务（**本地取消不证明远端停止**，引擎侧运行按记录另行核对）；新会话=新血缘开运行；/report=专门工作流 start_run | 决策 D6 排期 |
| B5 | 文件+文本 3 秒合并窗、尾文等附件 15 秒、追问 600 秒附件提示、inbox 停放/0.5 秒重试/超时处理 | inbound.py:22-31；gateway.py:375-454,1434-1546 | 带期限请求的语义（B07 F[3]；到期自动转处置） | 宿主已实现等价物；Hub 送达通道上线后迁移 |
| C1 | reply_stream 流式：stream_id 追加+finish；**10 分钟过期（846608）自动换新 id 重发** | gateway.py:1022-1050 | 通知类效果的"重发一次标可能重复"（D03 R[3]）；入账本需效果记录 | 决策 D2 |
| C2 | markdown 终答（耗时/工具数/答案分节）| gateway.py:655+,1599-1611 | 模型结论=V02 判断，标"语义未断言"；与已校验结果分层显示 | 决策 D6 |
| C3 | reply_media 发文件：upload_media→media_id；自动投递 agent 产物（按 mtime 过滤） | gateway.py:1808-1884；files.py:76-86 | 外发写效果 + 制品引用（artifact） | 决策 D2 |
| C4 | **主动推送：不存在**——一切外发都在会话帧内应答；全仓无 appchat/send、无 webhook 推送 | 清点结论（grep 无命中） | B07 送达通道缺口 | 决策 D2 核心：三选一 |
| D1 | ask_user 问询卡：编号问题+选项，用户在输入框答；按序号或标签匹配 | gateway.py:1257-1291,1785-1807 | 判断/澄清类请求（B07）+作答语义 | 决策 D5 |
| D2 | 附件即回答（accepts_file，刻意绕开选项标签匹配）；反序半程（inbox 已停附件） | gateway.py:1293-1432 | 澄清请求的回答=补传源文件（B07 R[5] 现成路径） | 同上 |
| D3 | submit_answers 按 qid+owner+thread_id 核验，回答回显确认 | gateway.py:1280-1291 | 回答须按身份映射前提落到具名账号（B07 R[6]，映射不上 IDENTITY_UNMAPPED） | 决策 D4 |
| E1 | 帧头 from.userid + name（name 常为空）| gateway.py:1072-1078 | 外部身份 | 决策 D4 |
| E2 | user_map.json：userid↔显示名持久化，反向 _to_wx_username | gateway.py:683-737,813-836 | 身份映射前提=D02 认证记录（目标+版本+src: 证据）；现为宿主私有 JSON | 决策 D4 |
| E3 | 多租户沙箱 scope 归一（大写外部联系人 bug 实证）、ContextVar 身份、fail-closed | gateway.py:30-62 | 隔离前提（D02 默认假，逐条认证） | 记录；上机核对 |
| E4 | 每用户 thread_id 会话/锁/checkpoint | gateway.py:563-600 | 运行血缘 predecessor | 宿主侧 |
| E5 | 同用户单活跃任务、忙碌回复、活跃计数、清理线程 | gateway.py:395-561 | 与租约"同时只一条观察"同构 | 宿主侧 |
| F1 | 云文档 streamable-HTTP MCP（管理员"可使用权限"URL，环境变量 WECOM_SMART_MCP_DOC_URL） | doc_tool.py:22-46 | 第二系统档案 wecom-docs（D01 R[0]） | 决策 D1 |
| F2 | wx_create_doc/update/list/search/read；内容哈希去重；SQLite DocumentRegistry 带 owner 权限 | doc_tool.py:48-278；tools.py:61-402；report_tool.py:22-28；registry.py | list/search/read=读；**create/update=同步写外发**，过效果前边界 | 决策 D1+D2 |
| F3 | /report → agent query → 报告技能 → 云文档落档 | gateway.py:1885-1912 | 工作流：报告=制品+判断；核验=Hub 校验结果，分开记 | 决策 D6 |
| G1 | systemd 服务安装/卸载、SIGTERM 平滑+8 秒看门狗、无 HTTP 端口 | main.py:40-75；install_service.sh/uninstall_service.sh | 宿主部署与 Hub 部署分属两处；对外暴露仍只有长连接出站 | 决策 D3 |
| G2 | EventAuditLogger、ArtifactRegistry | presentation.py:199-235；artifact_registry.py | Hub 侧对应物是 append-only 记录（B01）；宿主日志不入账 | 记录 |
| G3 | 运行时依赖 websocket-client/requests/pycryptodome + 官方 SDK（Python） | requirements.txt | **Hub 禁止引入 Python 运行时依赖**（AGENTS） | 决策 D3：宿主保持独立进程，经 MCP 连 Hub |

## 二、决策条目（草案）

**D1 系统包按真实三通道重塑。** (a) `wecom` 档案的 auth 改查询参数令牌形态，等 connectors 支持前按"宿主维护 vault 令牌"的过渡方案披露运行；(b) `appchat get` 保留声明、标注"当前机器人未使用，供群送达选项复用"；(c) 新建 `wecom-docs` 档案，第一期只声明读（list/search/read），create/update 留待外发授权。改动全在 packs，不动核心。

**D2 送达通道与外发授权（功能风险最高的一条）。** 智能机器人长连接只能应答会话内帧，Hub 主动推送需另择通道，三选一：**a) 群机器人 webhook**（最简单：一次 HTTP POST 即可通知，最贴合通知类效果语义，建议第一期采用）；b) 应用消息主动推送（私聊可达、但要加 agent 配置与可信域名）；c) 暂不 Hub 主动推送（送达只走控制台与 Circle 工具结果，机器人只承担"用户先开口"的会话）。选定后由 executor@1 写声明登记，配合 dispatch 的 notification 效果分支（README Need 2）。三选型对比（写声明形状已在包 README"候选写声明"节给出，均通过 `WriteDeclaration.safeParse` 校验，2026-11-02）：

| | a) 群机器人 webhook | b) 应用消息推送 | c) 暂不主动推送 |
| --- | --- | --- | --- |
| 可达范围 | 已配机器人的群 | 私聊成员（invaliduser 可证部分失败） | 仅用户先开口的会话内 |
| 幂等键 | 无（协议不带） | 无原生键；msgid 可回读、可撤回（认证后） | req_id+stream_id 会话内幂等 |
| 重试安全类（声明） | 可容忍重复：重发一次标"可能重复" | 不安全：丢回复走六种处置，先核对目标侧记录 | 同键安全（宿主内） |
| 满足方式 | 已生效（通知不可回读，B06） | 已生效 + 核对可得 msgid/invaliduser 证据 | 不发即无效果；送达只见控制台与工具结果 |
| 前提认证成本 | 低（一条 POST 路由 + 外发检查） | 中（推送、回读、撤回三组路由逐条认证） | 零 |
| 对评审闭环 | 复核问题直接进群，@具名成员；人答→身份映射落账号 | 私聊可达不依赖群；部分受众失败可证 | **判断类请求无法由 Hub 发起**，D6 的人复核只能靠用户主动来问，评审闭环不完整 |
| 第一期建议 | ✔ 推荐 | 备选（后续里程碑） | 保底（D2 未批时的默认形态） |


**D3 宿主归属与运行时。** 机器人宿主保持既有独立进程（Python 运行时不入 Hub 依赖），以普通 MCP 客户端接 Hub 六工具；宿主侧改动归 Circle 仓库分支（decision 8 范围），本地提交不推送。R03 的沙箱、版本、代用户权限三性在宿主上线前验收。

**D4 数据归属。** 身份映射（user_map.json）迁 Hub：按 D02 认证为前提、按 B07 R[6] 校验作答，宿主文件降级为缓存；DocumentRegistry/ArtifactRegistry 的**账本**归 Hub 记录（append-only），宿主 SQLite 只作缓存与性能件；EventAuditLogger 保留宿主侧，不入 Hub 账。

**D5 真实取样与逐项启用。** 上线前由 owner 的 `scripts/real/` 只读取样：gettoken/user get 的确切形状与错误码（含不认识成员时真值——本包合成档案现按 errcode 0 无记录表达缺档，取样后二选一）、云文档 MCP 的工具面与应答字段指针；随后按 D01 R[11] 逐条启用并重新 sign `pack.json`。ask_user→B07 的迁移排在通知派发实现之后。

**D6 评审闭环与分层。** 现宿主只有单一本地模型：起草之后，独立核验要么第二模型族（A04 R[1]/R[5]），要么第一期为**人复核**——经 D2 选定通道送达判断类请求、按 D4 映射回具名账号作答。机器人回答一律分层显示：Hub 校验事实 / 模型判断（标"语义未断言"）/ 未知，三层不混排（C2/F3 条目）。

## 三、非目标

本页不改 `hub/**`、不落代码；清点不含机器人项目路径与任何真实标识符；合成 fixture 仍未在真实租户验证（取样见 D5）。
