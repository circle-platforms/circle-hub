# 任务：上机和技能用的 Circle 主目录

依据：

- `hub-device-run.md` 第 11 条：上机第 5 步由 Circle 会话跑用例编译包的客户端脚本。评审用的专用目录（`scripts/real/circle-home.ts`）只放行 Hub 的六个工具和待办清单，`execute` 和技能工具都被拒，这一步在那里跑不了。
- `jev-skill.md` 的“先知道的”：jev 技能装在另一个主目录，`--send` 的 ask 钩子也要装进那个主目录自己的 `hooks.json`。
- Circle 文档（Circle 仓库 hub-mcp-client 分支，只读）：
  - `docs/hooks.md`：
    - 输入有 `tool_name`、`tool_input`、`paths`。变量已经代入，密钥写回成 `%名字%`。
    - 几条钩子里最严的决定生效。
    - 非零退出、超时、输出不是 JSON 对象，都算 deny。
  - `docs/skills.md`：技能目录的层级；`skill` 工具；技能自带的钩子要等会话载入技能以后才跑。
  - `docs/tools.md`：`execute` 的参数是 `command`、`background`、`timeout`。
  - `docs/settings.md`：`variables`。
  - `docs/security.md`：按名字存的密钥。

- 分支和工作树：`circle-home-skills`，目录 `circle-hub-circle-home-skills`，从 hub-redesign 开出。
- 可以改的路径：`scripts/real/circle-home.ts`、`scripts/real/circle-home.test.ts`。别的路径不动。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；`git commit -s`）。测试只用临时目录和合成的环境文件。
- 验证：`npx tsc --noEmit`；`node --test scripts/real/circle-home.test.ts`。

## 要做的

1. **加 `--profile review|skills`**，默认 review。review 写出的文件逐字节不变：现有测试照旧通过，另加一条字节对照。
2. **skills 写出的主目录**：
   - settings.json 和 review 一样：模型端点、Hub 的 MCP 条目、受保护文件、auto 模式。
   - settings.json 另加 `variables`：`HUB_URL` 取 `--hub-url`；给了 `--jev-model` 就写 `JEV_MODEL`，没给就不写。
   - secrets.json 只有 `HUB_TOKEN`。`JEV_API_KEY` 由所有者自己用 `/secrets JEV_API_KEY` 存，脚本不经手。
   - 建一个空的 `skills/` 目录，权限 0700。
3. **skills 的钩子**：数据目录 `hooks.json` 里一条，一个脚本。
   - 放行：Hub 的六个工具、`write_todos`、`skill`。
   - 只读的文件工具（`read_file`、`ls`、`glob`、`grep`）：`paths` 非空，并且每一条都在工作目录里面，才放行。
   - `execute` 只放行一种写法：`node <脚本> <参数…>`，后面可以带一段 `<<'EOF'` 的 here-doc，定界符要加引号，正文每行只能是 `%名字%`。另外：
     - 脚本是绝对路径，规范化以后在 `<主目录>/skills/` 下面（层数不限），以 `.ts` 结尾；
     - `node` 后面不许带任何选项（`-e`、`--input-type` 这类都拒）；
     - 参数一个一个看：要么是只含字母、数字和 `_ . / : % = @ , + -` 的词，要么是不含单引号的单引号串；
     - `background`、`timeout` 照常可以带；
     - 别的写法一律 deny，理由写“这个目录只放行技能目录里的脚本”。
   - 放行的 `execute` 还要过那个技能目录里 `hooks.json` 的 before_tool 钩子：输入相同，超时照 Circle 的规矩，取最严的决定。这样即使没载入 jev 技能，`--send` 照样出确认卡片。
     - 那份 hooks.json 读不了，或者钩子失败、超时、输出不是 JSON 对象：deny。
     - 技能目录里没有 hooks.json：allow。
   - 其余工具，以及读不懂的输入：deny。
4. **屏幕**：照旧只显示名字、有没有、长度。最后列出所有者还要做的事：
   - `/secrets JEV_API_KEY`；
   - 没给 `--jev-model` 时，`/variables JEV_MODEL`；
   - 技能装进 `skills/` 以后，跑各自的核对：`local-tools verify --digest`、`pack-files.ts --verify-install`。
5. **测试**：
   - review 的文件逐字节不变。
   - 放行：六个工具和 `skill`；`node <主目录>/skills/x/tools/t.ts --a b`；here-doc 正文是 `%JEV_API_KEY%` 和 `%HUB_TOKEN%` 的那种写法。
   - 拒绝：
     - `write_file`；
     - 工作目录外面的 `read_file`；
     - 命令里带 `;`、`&&`、`|`、反引号、`$(`、`>`；
     - 定界符不加引号的 here-doc，或者正文里有别的文字；
     - 路径里有 `..`，或者脚本在 `skills/` 外面；
     - `node -e`。
   - 技能自带的钩子：它回 ask，结果就是 ask；它失败、超时、输出不是 JSON，结果是 deny；没有 hooks.json，结果是 allow。
   - 合成一份 jev 那样的 `hooks.json`（带 `--send` 就回 ask）：没载入技能，也得到 ask。

## 集成者答复（2026-10-24 凌晨）

- **03:57，给 codex-e 的待通知排期**：trunk-fixes 和 jev-skill 都合入 hub-redesign 后，授权把 hub-redesign 合进本分支；合入条件与开始时机由集成者通知，不把这条待通知记录当成已经完成合并。
- 核对扫描覆盖全部目标脚本。Jev 的 `lib/local.ts` 中 `rename(temp, file)` 已由集成者按调用点复核，按该调用点摘要登记；不是把 rename 整类操作或任意改写放行，也不授权修改 Jev 业务代码。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。真实主目录由集成者建。
