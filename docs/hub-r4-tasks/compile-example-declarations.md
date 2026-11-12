# B3：可完整核验的用例编译合成示例

来源：所有者全量计划，#130、#144、#199；#253确认原件ID/引文已正确，但旧计划含四条未声明命令。基线aded2ffd，分支fix/compile-example-declarations。

## 允许路径

- `packs/workflow/case-compile/examples/{case-mindmap.json,start-run.json,submit-result.json}`
- `packs/workflow/case-compile/testing/undeclared-example.json`
- `packs/workflow/case-compile/{examples.test.ts,example-workbook.test.ts,pack-files.ts,pack.json,pack.test.ts,publish.test.ts,README.md}`
- `packs/workflow/case-compile/tables/workbook-format.json`：既有包/生成器同版约束的标识升版
- `packs/workflow/case-compile/samples/{positive,negative}/{typed-dispatch_policy.json,typed-workbook_verified.json}`：仅用同一recipe重生成版本标识相关字节/摘要，反例继续错误摘要
- `docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md`
- 本任务页

## 决定

合成入门案例改为随附冻结合约和命令树确实允许的单条间隔配置，期望逐字来自匹配脑图叶节点。旧含创建/查询/回滚计划与脑图原字节保留在非发布测试夹具，保留四条命令明确拒绝和生成器拒绝的负对照；不是放宽校验或将未知改满足。主示例全部ID/src经既有testing/examples.ts重新派生。runtime-contract-v2、profile、命令树/身份、类型/效果来源原字节不改。

用实际引擎/临时PG/真实macOS沙箱核验上传→投影→提交→已满足计划提取→客户端XLSX生成→后继冻结plan_result→独立逐行/字节核验。当前测试用合成产品/knowledge目录端口，README继续要求自备产品包/构建/资源；不声称真实系统可直接照抄运行。

case-compile源码3.9.18→3.9.19，仅新示例字节；schema与运行时逻辑不变，既有同版约束要求同步生成器身份标识/4个工作簿样本（只重算版本相关字节与摘要，不改变recipe和反例），两语兼容页同步。不发布生产包。

## 验收

先对旧主示例要求全计划满足取得确定失败，修复后全要求满足至工作簿后继；旧4条catalog/method拒绝保留。核对首行D列正是脑图原始层级根到用例标题、A列18位文本ID，原样引文可解析。类型、完整包/相关测试、manifest、文档实际结果另记。

## 实际验证

- 新全链路回归在旧主示例上确定失败：contract_methods unsatisfied，四处catalog/steps/{0,2,3,4}/args/0。负对照同时通过，未弱化为只断受理。
- 修复后实际引擎上传原字节、投影条目、提交计划的五个计划要求满足，工作簿要求仅缺输入；由已受理精确计划/原件生成XLSX，再由后继冻结plan_result核验全部要求满足。回读首AUTOID行A列是18位inlineStr，D列逐字等于投影path.join('>')，工作簿回执摘要等于上传摘要；逐字引文按同运行解析。
- `node --test "packs/workflow/case-compile/**/*.test.ts"`在本任务worktree执行：561通过、0失败、0跳过。含发布作者样本、真实PG/沙箱生产链路、原多命令四处拒绝/禁止生成、派发策略与本地CLI/暂存CLI同字节测试。
- 首次从父工作目录跑完整包为559通过/2失败：一个旧示例结构断言仍读新主例，已改读保留原字节负例并保持全部前置/判断/逆序清理断言；另一个CLI相对路径启动了父目录3.9.18生成器，改从正确worktree执行，测试与实现没放宽。同步升版前4个样本的发布拒绝按规则重生成版本相关字节，不改断言或负摘要。
- `npm run typecheck`退出0，`npm run test:docs`333通过、0失败、0跳过；manifest核对通过。脚本对比origin/main证明runtime-contract-v2/profile/command-tree/identities/typed-authority-source五个原件字节不变，负对照原脑图/计划逐字与main一致。
- 未运行全仓unit/acceptance、Linux隔离、真实模型、真实设备或生产包发布/部署。静态全满足证明合成绑定链路，不证明设备可执行、语义充分或真实清理可行。#144只新增真实生成首行证据，#143真实用户发现/调度仍未在此验证。

## 集成注意

#253在另一个独立分支增加了对当时主示例的4条未声明命令拒绝回归。合入本任务时该回归应读取本任务保留的testing/undeclared-example.json原字节，保留相同4处拒绝/生成器拒绝断言；不要把新单条示例仍当旧多条案例，也不要删除负对照。两个分支不相互改写。主示例的新摘要由实际文件计算，恰为历史旧文案曾错引的ddc9b8bf…，这里不据历史字符串猜测，回读测试/派生器才是证据。
