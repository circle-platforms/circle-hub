# 任务：企微智能机器人系统包（只读面骨架；外发走执行器写声明，另行决策）

infotest 的企微智能机器人用来做测试用例评审：机器人进程与企业微信长连接收文件和消息，本地模型按包里的规程起草，评审结论经身份映射交给具名的人复核。按 r4：带模型的宿主是 R03（Circle 侧，里程碑 1 的 server 包不交付）；企微协议面是一个新系统类型（D01 R[0]：一个系统档案加无 I/O 投影函数，不改核心）；对外发送不是读路由，是部署时登记的通知类效果（D07）。本任务只落系统包的只读骨架和三条 Needs，核心与宿主都不碰。

- 分支：`codex/wecom-robot-pack`（本地开自 main，未推送；本页随包一起交，integrator 审阅后可按 decision 14 的惯例改页）
- 可以改的路径：`packs/system/wecom-robot/**`、`tests/fixtures/wecom/**`、`packs/workflow/case-review/packaging.ts`（只加一行注册）、本页。别的路径不动。
- 要做的事：
  1. `system.json`（system@1）：`wecom:user:<userid>` 与 `wecom:chat:<chatid>` 两条只读读取，信封 `{errcode, errmsg}`、errcode 0 为成功；路由逐条列出（GET 成员、POST 群详情），发送路径与 gettoken 一条都不在清单里，由传输层拒绝。
  2. `functions/wecom.ts`：`memberProject`、`chatProject`（纯函数，沙箱里跑）；应答没有的字段留 null 不猜；不认识的人或群是确定的缺档（`wecom.absent`），不是失败也不报成功。
  3. `tests/fixtures/wecom/index.ts`：合成成员、群与一条同前缀的发送路径（结构照真实服务，取值全合成）。
  4. `wecom.test.ts`：清单拒绝发送与 gettoken；投影保留所答、缺则 null；缺档成事实。pack.json 用共享工具 sign。
- 明确不做：不动 `hub/**`；不实现通知类效果的派发分支；不登记 executor、不接真实企业微信。三条 Needs 写在包 README（connectors 的 GET 令牌登录形态、dispatch 的 notification 效果分支、owner 的外发授权与宿主归属）。
- 待核对：本档案未经真实租户取样（简报第 8 节不覆盖企业微信）。部署启用前，owner 的 `scripts/real/` 只读核对逐条路由、信封码、不认识成员时的真实应答形态（合成档案用 errcode 0 无记录表达缺档，真实服务可能回非零码，核对后二选一），再按 D01 R[11] 逐项启用并重新 sign。
- 验证（已跑）：`npx tsc --noEmit` 退出 0；`node --test "packs/system/wecom-robot/wecom.test.ts"` 8 通过、0 失败、0 跳过、0 todo；`node packs/system/wecom-robot/api.ts check` 显示 pack.json 与文件一致。
- 提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号；不推送、不建 PR；不碰持久部署、密钥和企业微信真实系统。
- 完成回报：提交号、测试数量、上面"待核对"没有做（需要 owner 授权后由监督者跑）。
