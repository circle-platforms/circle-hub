# B5：连接章节目录与能力用途

来源：所有者确认A独立编辑+共用方向；#211/#219，基线aded2ffd，fix/console-section-navigation。

## 允许路径

- `hub/server/console/{connections.ts,ui.ts,interaction.ts,style.ts,packs.ts,pack-display.ts,pack-sources.ts,operations.ts,personal-packs.ts,README.md}`
- `hub/server/console-section-navigation.test.ts`
- 本任务页、`CHANGELOG.md`

## 实施与验收

连接页用明确的页内目录替代seg分段外观：本页内容标签、普通章节链接、sticky目录、当前可见章节aria-current=location。章节仍同页完整可读，支持原fragment、键盘、无脚本直接锚点；滚动/hash/增强导航/live更新后同步，验证system-sources和对应live-system-sources各自唯一，不能破坏主题选择真正互斥分段。

工作流/技能/接入页和发布入口给简短用途/去向，正式包类型/清单校验/权限保持；通用技能仅做法，不承诺自动验收/不存在的功能。只改UI解释，不做Hub语义匹配。

实际临时HTTP回归检查admin/member目录与链接不越权，发布kind保持，所有目录fragment唯一。深浅主题×五宽度1440/1180/1024/760/390浏览器检查目录保持可见、章节不被遮挡、滚动当前位置/深链/前后退、键盘进入目的节、主题互斥与CSP不变，空/有合成内容，watermark不增。单独与#263文字修正补丁检查共存，#266保持独立。本批不宣称解决其它宽表/详情阅读问题。

## 实际验证与修正

- `node --test hub/server/console-section-navigation.test.ts hub/server/console.test.ts "hub/server/console/*.test.ts"`：68通过、0失败/跳过；加入私人发布实际路由后专项3通过。首次kind断言错误地假设hidden字段，查实原入口用action URL的kind后修正断言，逻辑未变。
- `npm run test:docs`：333通过、0失败/跳过。`npm run typecheck`最终退出0（私人路由测试明确watermark端口，未改生产类型）。
- `node --test tests/acceptance/39-r5-t9-2-skill-packs.test.ts`：1通过、0失败/跳过，真实临时Hub/合成技能，非真实业务系统结果。
- 浏览器矩阵40案例/60捕获：admin/member连接页×两主题×五宽度（列表有合成凭据、环境为空），工作流列表/技能发布页×两主题×五宽度。验证目录固定可见、章节唯一、键盘Enter定位和焦点、滚动后单一aria-current、前后退/深链、增强更新、主题唯一radio、无整页横溢、读取watermark不增；新文档禁脚本原生envs锚点通过。截图在ignored/temp，仅人工看两张代表，不声称全部逐张审阅。
- 浏览器最初selector转义错误修正；接近页尾时原生滚动夹紧，不能保证任意标题对齐视口顶部，因此读取几何而非伪造期望；已聚焦且仍可见的目录目的节优先标记。一个禁脚本步骤错误等待rAF而挂起已停止，修正无脚本等待路径后完整通过，不计为成功。
- #263长连接模板行冲突使apply-check失败；在独立detached #263树仅手工替换import和seg调用，保留其所有“已登记/最近凭据使用”文字。组合4测试通过、0失败/跳过、typecheck退出0，完整组合浏览器同样40案例/60捕获通过。源分支未合并/重写，组合树未提交/推送。
- 末轮截图检查后把列表用途从tooltip改为每类型首节可见说明，避免用户仍需悬停才知道用途；发布页/连接页原已可见。最终专项12通过、0失败/跳过，typecheck退出0；最后40案例/60捕获矩阵完整通过，包括新文档禁脚本锚点。
- 未做部署/真实业务读写、全仓npm test、Linux验证或其它列表/详情/执行流程验收；#194仍未变更。

## 修正（2026-11-10）

把草稿合并成临时本地树跑控制台测试时，本分支单独就有三项失败（快速 CI 不跑这些测试）：

- `console-wording.test.ts`：连接页内导航的 `aria-label` 用了文案守卫禁用的旧词“目录”（“连接页内目录”）。改为“连接页分区”，导航本身的可见标题“本页内容”不变，测试同步。
- `console-places.test.ts` 的“工作流和通用技能有各自的列表……”仍断言卡片上的悬停提示（`title="规定做法与验收要求……"`），而本分支把它换成了列表上可见的用途说明（每种每页显示一次，在页面的第一个范围分组里）。改为断言页面含两种用途说明，且不再用旧的悬停提示。
- 上面那项失败也使 `console-places.test.ts` 里外层的“operations and commands”分组报错，随之恢复。

修正后控制台目录、`console.test.ts`、`console-places`、`console-wording`、`console-section-navigation` 和验收 39（技能包）共 91 项通过，0 失败，0 跳过。
