# B4：长弹窗与计数口径

来源：所有者 2026-11-09 全量修复计划；基线 aded2ffd，分支 fix/console-dialog-counts。关联 #202、#205、#207、#199。

## 允许路径

- `hub/server/console/style.ts`、`spaces.ts`、`packs.test.ts`、`style.test.ts`、`README.md`
- `hub/server/console-knowledge.test.ts`
- `tests/acceptance/48-knowledge-console-memory.test.ts`
- `docs/hub-r4-tasks/console-dialog-counts.md`、`CHANGELOG.md`

## 方向与验收

- #205 先使用长成员删除预检与通用表单弹窗合成页面，在深浅主题及三宽度验证真实几何。正文内部滚动、头尾不随滚动离开；Esc与关闭仍可用，不作“原来无法关闭”的错误诊断。只改本地composition CSS，不编辑冻结共享设计源或生成文件。
- #207 区分所选版本的文件夹条目记录总数与本页当前可读条目，说明历史/撤回口径及分页范围。不得用缺证据的0代替未知，不能隐藏或删除历史记录以统一数字。
- #202 当前工作流和技能统一区域，列表/详情共享相同listing；补对照回归验证，未重现不编造修复。
- 执行受影响定向HTTP、知识验收、类型/文档与浏览器；各自实际结果完工记录，未执行不报通过。

## 实际结果

- 浏览器先确定复现#205：390×1000时panel高800、scroll1120，body高/scroll均1012，底部越过面板。修复后同尺寸panel高/scroll均800，body高692/scroll841；正文滚动前后标题y100、底部y900不变。
- 最终真实HTTP删除预检 + 真实容量表单（追加30段合成说明来构造长表单）×两主题×三宽度，共12图；逐例断言正文承担滚动、面板不滚、头尾固定、Escape关闭，records水位不变，不发送写入。
- #207 真实知识验收创建修订及撤回后记录总数3、当前列表1，先确定旧标签无法解释差异，修复为独立范围说明；没有删除历史或改计数算法。
- #202 新增回归验证工作流/技能列表与两类详情全部/我的/团队均为同一去重范围，排除产品和系统包，旧版本不多计。当前主线未重现旧部署独立技能页的问题，仍不据此关闭历史问题。
- `node --test hub/server/console/packs.test.ts tests/acceptance/48-knowledge-console-memory.test.ts`：12通过、0失败、0跳过（包括9项真实知识/记忆验收）。首轮夹具错用了withdraw签名、匿名chrome不显示侧栏，修正后计数标签回归才确定重现；夹具错误不算产品缺陷。
- `node --test "hub/server/console/*.test.ts" hub/server/console.test.ts hub/server/console-knowledge.test.ts`：74通过、0失败、0跳过。
- `npm run typecheck`退出0；`npm run test:docs`333通过、0失败、0跳过。共享设计源与生成资源未变。
- 未运行全仓unit/acceptance、Linux隔离或实际部署；合成预检和容量表单不证明真实删除已发生。

## 修正（2026-11-10）

把草稿合并成一棵临时本地树跑整套单元测试时，`hub/server/console-wording.test.ts` 失败：本批新增的计数口径说明用了文案守卫禁用的旧词“历史”（“条目记录（含历史及撤回）”）。该守卫在 PR 的快速 CI 里不运行，所以此前没有发现；原 `origin/main` 上通过，本分支单独也失败。改为“早期版本”（“条目记录（含早期版本及撤回）”），验收断言和 README 同步；其余不变。修正后 `console-wording`、控制台 `packs.test.ts` 和验收 48 共 16 项通过，0 失败，0 跳过。
