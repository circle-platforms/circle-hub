# B3/B7：规格目录可发现的工作流入口

来源：所有者全量计划，#191、#199。基线 aded2ffd，独立分支 fix/source-document-discovery。

## 允许路径

- `packs/workflow/source-read/{workflow.json,SKILL.md,functions/project.ts,pack-files.ts,pack.json,pack.test.ts,README.md}`
- `packs/workflow/source-read/discovery.test.ts`
- `docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md`
- `docs/hub-r4-tasks/source-document-discovery.md`

## 方案

main已有manual-store的manual:spec-list:configured，只列spec_folders直接成员。source-read新增可选spec_list槽接受这个类型，保留准确路径文件读取；不添加文件名匹配、语义筛选或自动抓全文。规程要求先读列表再由客户端模型选择候选、按引用/逐字内容核对；未查、缺配置、不完整目录和真正空列表分开，不从需求附件空/知识检索无命中推出文档不存在。

未启用的来源不推荐为现成路径；OpenKM只在已确认启用且获准时使用，不靠手册镜像或包存在推断资源已启用。真实spec_folders配置、生产包发布/升级均不执行。#190独立分支已占用source-read 0.1.7，本任务用0.1.8避免同号异字节；main包为0.1.6，0.1.8不隐含#190语义。

## 验收

先以真实MCP/引擎、临时PG、manual-store WebDAV合成服务器证明槽缺失；修复后list_task_packs发现槽、仅PROPFIND列目录、GET只在显式file运行发起、原文可按冻结引用读回。未配置目录有具体下一步，不成为无文档；空目录保持列表范围和不代表全部来源缺席，路径越界/未授权仍受已有系统包约束。运行source-read包测试、manual-store列表/全套、相关验收、类型/文档和包摘要检查；如有跳过如实记录。

## 实际结果

- 修复前已获分配的source-read 0.1.6通过真实MCP返回8个槽，无manual:spec-list，新发现回归确定失败。首次未给管理员分配workflow导致空目录，是夹具问题，修正后才取上述红证据。
- `node --test "packs/workflow/source-read/*.test.ts" "packs/system/manual-store/**/*.test.ts"`最终49通过、0失败、0跳过；使用实际macOS沙箱、临时PG、官方MCP SDK与合成WebDAV。5个新往返场景覆盖两个目录只各发一次PROPFIND、准确path显式GET且正文逐字回读、真正空目录、未读目录complete:false、已声明但资源禁用、缺目录设置。既有系统包列表测试覆盖越界/异源条目与旧目录设置，不改它的读法。
- 空目录夹具用/empty/作为文件键会让通用stub重复列集合自己，改为单个合法WebDAV集合响应；生产连接器没有更改。类型首次把可选slot当必填，按公开schema更正，无运行时放宽。
- `node --test tests/acceptance/36-source-unreachable-exit.test.ts`：3通过、0失败、0跳过。`npm run typecheck`退出0；`npm run test:docs`333通过、0失败、0跳过；包manifest由pack-files.ts生成并核对通过。
- 未配目录/禁用来源返回错误且无网络请求，不生成SOURCE_ABSENT；具体spec_folders修复在规程/管理员配置边界说明，不将中性错误改成存在性披露。没有真实系统读取、线上资源验证、生产包发布、客户端真实模型效果或全仓unit/acceptance/Linux验证。#191只交付调用路径和合成证据，真实资源配置与观察仍未完成。
