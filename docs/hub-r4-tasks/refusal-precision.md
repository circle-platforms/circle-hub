# 任务：拒绝照实说，设备命令照 CES 放行

依据：决定 114（所有者，2026-11-01：重跑"复现一条 PLM 缺陷"时先后问"这个是什么问题""这个报错呢"；模型停下来问用户要不要补合约时说"这三个选项都不应该是操作者应该做的事情，这明显是我们的设计问题"，随后"可以，照 CES 改，做完部署发布再接着跑"）；通用模型 D05 R[3]、R[8]。

重跑里四处回答没说实情：
- 读缺陷时 Hub 的沙箱一次没观测到函数进程的内存，按规则停了函数，回答却写"由系统包负责人修复函数后重读"；
- 模型把设备名写进 test-bed 的 need.devices，拒绝说设备类型是 ""，位置写在清单输入上，列表里也看不出 need 的形状；
- 核心对参数模式的拒绝只说"不符合任务包声明的模式"，不说错在哪里；
- case-compile 只放行运行器合约 command_scope 里手写的 19 个命令子树，缺陷要的 DNS ACL 命令不在里面，只能由维护者改合约，模型就把这件事做成了让用户选的选项。

CES 和 InfoTest 的做法：InfoTest 的 runner 发用例里的命令，用例之间靠 clear() 收尾；CES 放行命令文法认得的全部设备命令，只无条件禁一小组破坏性命令（InfoTest knowledge/data/compile_ref/domain_grammar.json 的 destructive_commands：路径里的 reboot、reload、shutdown、halt、poweroff，以及整机清配），理由是自动化测试环境共享，这些命令会把整台设备连同管理口带走；对象级的配置和清除照常放行。

- 分支和工作树：`refusal-precision`（从 hub-redesign efb46fe38 开出）
- 可以改的路径：
  - `hub/connectors/errors.ts`、`hub/connectors/read-exit.ts`、`hub/connectors/read.ts`；
  - `hub/runs/engine/projection.ts`、`hub/runs/engine/start.ts`、`hub/runs/engine/slots.ts`；
  - `contracts/src/pack.ts`、`contracts/model.json`，以及 `npm run gen:contracts` 重新生成的文件；
  - `packs/workflow/test-bed/**`（升 1.2.15）、`packs/workflow/case-compile/**`（升 3.9.9）；
  - 以上各处的测试，`packs/workflow/template-gap/engine.test.ts`（参数位置更细）；`docs/hub-r4-progress.md` 补记决定 114。
- 规则：同前（不推送、不建 PR；测试只用合成数据）。部署、发布、合约和执行器更新经所有者同意（"做完部署发布再接着跑"）。

## 做了什么

1. **沙箱状况不怪包**：系统包函数和任务包投影函数遇到沙箱不能运行或观测（SANDBOX_UNAVAILABLE）时，Hub 在服务内重试一次（包内函数没有副作用，D05 R[3] 读者出错先在服务内重试）。重试成功的记进读取清单的提示。还失败时用自己的码，回答写"Hub 的沙箱这次没能运行系统包函数（不是函数的错）"，修正写"Hub 已在服务内重试过一次；原样重读；连续出现时请 Hub 管理员检查沙箱"。
2. **参数错在哪里**：核心按任务包声明的参数模式核对不过时，用和提交同一套结构问题写出位置（如 /parameters/need/devices/1）、要什么、给的是什么。任务包自己的拒绝可以带位置（PackError.pointer，只认本次调用的 /parameters、/inputs），没有才落到被判对象。
3. **test-bed 1.2.15**：need 声明完整模式（devices 每项 {type, count}，build 是构建名），列表里显示，Hub 开运行前就按它核对；包自己的 bad_need 照实写给的是什么、第几项、怎么写，带位置；不再说类型是 ""。
4. **case-compile 3.9.9，照 CES 放行设备命令**：
   - runtime-contract@2 加封闭补充声明 `destructive`：source、sha256，和 exact、prefixes（锁定命令树的路径）、segments（路径段）至少一项；按解析出的命令身份路径比对，不按文字；
   - 设备命令效果没声明 command_scope 和 commands 时，合约有 destructive 就放行锁定命令树能完整解析的全部命令，只拒破坏性命令；没有 destructive 照旧不放行，并写明原因；声明了范围的照旧收窄，范围内的破坏性命令也拒；
   - 捕获恢复的目标按同一规则核对；
   - 命令里的地址参数没声明角色时，按本环境地址核对（本环境设备的地址、本血缘租约或替换换入），声明了角色却缺 bed_member 的仍是缺口；
   - 合约核对的结论写明命令按什么放行（声明的来源、摘要和禁的是什么）；
   - SKILL 第 2 步写明同样的规则；仍缺只有维护者能补的事实时，按补证请求交给具名维护者，告诉用户在等哪个请求，不让用户替维护者选。
5. **通用模型**：D05 R[8] 补一句：修正的执行者不是读者时不写成读者的选项（变更 changes17）。

## 生产数据（不在 Git）

运行器合约去掉 apv_cli 的 command_scope、加上 destructive（来源是 InfoTest 的 domain_grammar.json 及其摘要），原合约身份不变，runtime-profile 不用改；执行器授权改到 case-compile 3.9.9。
