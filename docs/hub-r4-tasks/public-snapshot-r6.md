# 任务：把集成树的新增内容按公开身份同步成 R6 快照（只在公开副本里做，不提交，不推送）

依据：所有者 10-27 夜的指令（把当前代码合并提交到 GitHub，发现的问题先在 GitHub 报 issue）；公开仓库里的 `docs/hub-r4-publication.md` 和 `docs/hub-r5-publication.md`（上两轮的做法和扫描清单，**先读完**）。

## 位置

- 私有集成树（只读，不要改、不要在里面提交）：集成者的 `circle-hub-redesign` 工作树，分支 `hub-redesign` 的 `768ff328`（NEW）；上一轮公开快照的私有来源是 `a203f297`（OLD）。用 `git -C <该工作树> show/archive/diff` 取内容。
- 公开副本（你的工作目录）：同级目录的 `circle-hub-publication` 工作树，分支 `hub-r6`，从公开 `origin/main`（`06d0426`）开出，**只有公开历史**。改动留在工作区，**不要 commit、不要 push、不要用 gh、不要联网访问 GitHub**（装依赖的 `npm ci` 可以）。提交由集成者做（作者身份、签名行要统一）。

## 做法（上一轮的做法，三方合并）

对 `git diff --no-renames --name-status a203f297 768ff328` 里的每个路径 P（排除下面的"不带"清单）：

- 路径映射：`packs/product/apv/**` → `packs/product/famx/**`，路径里的 `apv`/`nsae` 一律按下面的映射；
- 三方合并：base = T(OLD 版本)，theirs = T(NEW 版本)，ours = 公开副本里该映射路径的现有文件，用 `git merge-file`；新增文件直接放 T(NEW)；删除的文件只在公开文件与 T(OLD) 逐字相同时删，否则保留并记入报告；
- 冲突逐个手工解，按"公开侧已有的修正保留、新增逻辑带上"的原则（公开侧有 CI 可移植性、合成夹具、资源清理、分区测试等修正，不要回退它们，也不要放松任何断言）；
- `contracts/generated/**` 不手工合并：合并完源文件后用 `npm run gen:contracts` 重新生成；
- 各包 `pack.json` 的文件摘要和签名用各自的工具重签（`node packs/<种类>/<包>/api.ts sign`，看 `check`）；已发布版本的内容变了就升版本，不复用已发布的身份；作者样例/工作簿样例用拥有它们的工具重新生成；
- 不要改任何依赖完整性值（SRI）、内容摘要、签名的字面（上一轮因此出过事故，见 `docs/hub-r4-publication.md` 最后一节）；

## 公开身份映射 T（从上两轮的公开/私有对比里学到的，不全，遇到新的不要猜）

- 产品族：`APV`→`FAMX`、`Apv`→`Famx`、`apv`→`famx`；`NSAE`→`FAMY`、`Nsae`→`Famy`、`nsae`→`famy`。注意设备编号 `apv0`/`apv1`… 在公开侧是 `afamx0`/`afamx1`…（不是 `famx0`）。
- 平台/OEM 名（按"以 `-`、`_`、`.` 或非字母数字分隔的整词"替换，不要替换单词内部）：`HG`/`hg`→`SY`/`sy`；`FT`/`ft`→`SZ`/`sz`；`UOS`/`uos`→`DEMOOS12`/`demoos12`；`KylinV10`/`kylinv10`→`Demoos10`/`demoos10`；`neokylin`→`demoos11`；`zhaoxin`→`demoarch`；组合如 `hg-k`→`sy-k`、`ft-kylinv10`→`sz-demoos10`、`hg-uos`→`sy-demoos12`、`zx-neokylin`→`zx-demoos11`；构建名里的 `Rel_FAMX-HG-K_…`→`Rel_FAMX-SY-K_…`。
- 其他：`InfoTest`→`SyntheticReference`；`infosec-platform`→`legacydemo-platform`；路径里的本机用户目录一律改成 `synthetic-homes` 一类中性夹具根（看公开侧现有写法）。
- 公开侧的文字有一部分是英文改写的（README、包说明）；三方合并时以保留公开侧写法为先。

## 不带的清单（私有记录/本机/真实环境相关）

`docs/**`（整个目录都不带；集成者另写一份公开的 `docs/hub-r6-publication.md`）、`scripts/real/**`、`references/**`、`foundation/**`、`.github/**`、根目录的 `README.md`/`AGENTS.md`/`CONTRIBUTING.md`/`CHANGELOG.md`/`package.json`/`package-lock.json`（这几个在 OLD→NEW 没有依赖变化）。`.github/checks/**` 里 OLD→NEW 的变化也不带，但如果你合并后公开的 docs 检查因此失败，把原因报给我。

## 红线（遇到就停下来报，不要自己判断放过）

- NEW 里新增的行出现下面任一类而映射 T 没覆盖：产品/OEM/平台/内部项目名、私有网段地址（`10.`、`172.16–31.`、`192.168.` 里除保留示例段 `192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24` 以外的）、主机名/URL、本机用户目录路径、邮箱/账号、凭据形状、真实构建名/缺陷号/运行号/文档编号（敏捷平台脑图编号、PLM 编号）、日志/转储。把文件、行和原因记进报告，**这个文件先不带**，并说明不带的后果。
- 任何断言、白名单、安全检查的放松；任何测试被删。

## 验证和扫描（都要做，数字都要报）

1. 先读公开仓库 `.github/workflows` 和 `package.json` 的脚本，按它们的分区跑：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；单元分区；docs 检查；用临时 PostgreSQL 的验收；引用存档测试。并发最多 2。跳过的测试单独列，不算通过。
2. 扫描：对**整个工作区**和**相对 origin/main 的全部改动**各做一遍：`git grep` 的禁用词清单（上面"红线"那几类 + `apv|nsae|infosec|hg|ft|uos|kylin|zhaoxin|InfoTest` 作为整词）、自定义正则、`gitleaks`（8.30.1 已装，目录扫描和改动扫描都必须零命中，不加允许名单；沿用上一轮"凭据形状的合成夹具在运行时构造"的做法）。扫描产物放在仓库外（`~/Library/Application Support/circle-hub-acceptance/handoff/` 下），不要进 Git，里面的凭据要打码。
3. 对比：`git diff --stat origin/main` 的文件数和私有侧 `a203f297..768ff328` 的文件数，解释差额。

## 报告（写到仓库外，终端里只回一行）

写 `~/Library/Application Support/circle-hub-acceptance/handoff/publication-r6-report.txt`：带了多少文件/没带多少及原因；冲突清单和处理；升版本的包（旧→新）和重签的包；测试各分区计数、跳过、失败；扫描结果（命中数、每个命中的上下文判断）；没解决的事。工作区里不要留下任何扫描产物或临时文件（`git status --short` 只应该是要提交的改动）。

做完在终端里回报：一行结论 + 报告文件路径。中途遇到需要我定的事，直接在终端里写清楚问题再等。
