# 任务：允许共享初评运行作为独立复核前驱

来源：所有者 2026-10-27 的 predecessor-view 简报。A04 F[0] 允许人且非作者按账号作独立判断；`predecessor_access: view` 只给当前读者只读可见性，不授予修改、提交或租约权利。

## 契约判断

- `start.ts` 在该声明存在时用 `canViewRun`：运行者、管理员或经分享授权的用户都可读；未声明时 `canSeeRun` 只认运行者或管理员。
- 发布校验要求只读前驱的所有要求项都 `independent_of: predecessor`。禁止自动绑定的校验专指 `criterion_review`，不取消 `case-review-verify` 已有的 `default_from_predecessor` 行为；`verification`、`final` 已有独立声明，`suggestions` 必须同步补齐。`case-review-report` 的 `overall` 没有独立声明，本次不适用，不改。
- 同账号和管理员路径的旧测试不改，保留 `31-predecessor-default` 对默认绑定的既有断言。新增另一已分配包账号的未分享拒绝、运行与上传原件分享后的复核受理、撤回分享后同形拒绝。

## 可改路径

- 本任务页。
- `packs/workflow/case-review-verify/workflow.json`。
- `packs/workflow/case-review-verify/requirements.json`。
- `packs/workflow/case-review-verify/README.md`。
- `packs/workflow/case-review-verify/SKILL.md`。
- `packs/workflow/case-review-verify/pack.json`，补丁升版并用 `node packs/workflow/case-review/packaging.ts sign case-review-verify` 重签。
- `packs/workflow/case-review-verify/predecessor-view.test.ts`（新增）。
- `hub/runs/packs/validate.ts`，仅将禁止自动绑定的校验限定到 `criterion_review`，保留普通只读前驱的默认绑定。
- `package-lock.json` 仅在确有该包版本引用时同步。

不改其他 `hub/**`、`contracts/**`、`case-review-report` 或旧测试。

## 验证

先跑新测试与 `case-review-verify` 包测试、类型检查；再以并发 2 跑 docs、contracts、hub、packs、acceptance（含 oracle）、scripts 和归档检查。只暂存显式路径，检查提交差异与整树安全边界，使用带说明的 `merge-locked.sh` 合入并报告计数。
