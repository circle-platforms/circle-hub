# 通用取值的受控安装材料

这些程序只供部署者审阅后，在已授权的主机上运行。开发测试使用合成 systemctl、目录、SQLite 和锁；不连接 Hub、网关、跳板机或设备。无凭据参数，不读取环境文件或密钥库。

## 五个运行文件和安装包

运行文件从明确的完整 Git 提交读取，不从工作树猜版本：entry.py、cell_gateway.py、cell_runtime.py、table_cell.py、test_xlsx.py。安装器、只读观测器分别计算摘要；它们的来源字节与五个运行文件的来源分开记录。生成包并不执行安装。

```sh
node scripts/real/bed-side/install/build-bundle.mjs \
  --repo "$SOURCE_REPOSITORY" --commit "$FULL_RUNTIME_COMMIT" \
  --out "$NEW_BUNDLE_DIRECTORY" \
  --base-hub-contract "$BASE_HUB_RULE_FILE" --objects-file "$OBJECTS_JSON_FILE"
```

不提供后两个文件时只能生成明确标记 missing_requirements 的未就绪材料，安装预检会拒绝。生成器不覆盖既有输出目录。

由运维使用第二实例现有的管理员 CLI 上下文，确认**当前执行器实际绑定的规则原件**及其 SHA256。执行器定义摘要不是规则原件摘要；不能取同名的最新记录代替实际绑定。

```sh
circle-hub original list --external "$KNOWN_RULE_EXTERNAL_PREFIX" --limit 100
circle-hub original export "$RULE_ORIGINAL_SHA256" --out "$BASE_HUB_RULE_FILE"
```

original list 只列 read 来源的原件，external 是前缀筛选；查不到不等于原件不存在。导出的文件须确为当前 runtime-contract@2 类型化规则，保留原字节与身份。对象名单是另一个 JSON 字符串数组，取同一规则 objects 里已启用、且管理员明确决定向新执行器开放的 e（或 name）；不凭设备名字猜、不默认开放全部。当前没有独立的 objects export CLI。可由部署者对导出的同一文件做以下纯本地筛选（命令未在真实资料上执行）：

```sh
node -e 'const fs=require("node:fs");const [base,out,...names]=process.argv.slice(1);const d=JSON.parse(fs.readFileSync(base,"utf8"));const enabled=new Set(d.objects.filter(x=>x.status==="enabled").map(x=>x.e??x.name));if(!names.length||new Set(names).size!==names.length||names.some(x=>!enabled.has(x)))throw Error("Object selection does not match the enabled rule objects");fs.writeFileSync(out,JSON.stringify(names,null,2)+"\n",{flag:"wx",mode:0o600});' "$BASE_HUB_RULE_FILE" "$OBJECTS_JSON_FILE" "$APPROVED_OBJECT_NAME"
```

## 只读预检、安装和紧急撤回

```sh
sudo "$SERVICE_PYTHON" "$BUNDLE_DIRECTORY/install/installer.py" preflight --unit "$SERVICE_UNIT" --bundle "$BUNDLE_DIRECTORY"
# 预检只读并结束。部署者审核输出及另行完成 Hub 一侧实时预检后，才调用 install。
sudo "$SERVICE_PYTHON" "$BUNDLE_DIRECTORY/install/installer.py" install --unit "$SERVICE_UNIT" --bundle "$BUNDLE_DIRECTORY" --timeout 30 --stable-seconds 10
# status 只读，不要求安装包、观测器或服务已运行。
sudo "$SERVICE_PYTHON" "$INSTALLER_FILE" status --unit "$SERVICE_UNIT"
# 紧急撤回不要求服务已启动、不要求观测器或完整安装包。
sudo "$SERVICE_PYTHON" "$INSTALLER_FILE" rollback --unit "$SERVICE_UNIT" --timeout 30 --stable-seconds 10
```

路径从 systemctl show 的现行启动命令、WorkingDirectory、FragmentPath 发现；不转储配置、不执行 show 的输出。仅支持明确的 Python 原网关入口或本组件入口，未知格式停止，不猜目录。仅新增本次 drop-in，不重写原 unit；drop-in 中持久化必要运行路径已获 Boss 批准。

安装写入前逐步核无作业、无有效预订、床锁空闲、版本与摘要。复制到独立版本目录、导出规则、加入 drop-in 后重启；新入口未能在给定时限进入运行或装后核对失败，自动尝试撤回，并同时报告原失败阶段和恢复状态。若原服务本身也起不来，报告恢复失败而不是宣称成功；保留组件/规则和任务，不清锁、不杀 runner。

重启前记录 NRestarts；显式重启后的首次采样必须为0，不能把清零后已经发生的自动重启同旧基线比较而误判成功。进入运行后还须通过稳定观察（默认10秒），期间状态持续为 active/running、主进程号不变、NRestarts不增加。计数未知或不能证明稳定时拒绝通过，安装触发自动撤回；撤回后的原入口也用同一标准核对。合成测试注入时钟，不靠真实等待或绝对耗时上限判定。

撤回只在本次 drop-in 可唯一认出且内容逐字相符时删除它，再 reload/restart，核恢复为原入口且运行。没有服务运行、观测器或空闲前提。内容不符或存在多份候选时拒绝删除，不影响其它 drop-in。目录后清理由部署者另行确认，没有自动删除组件或任务的功能。

## 运维约束

包装入口仍安装时，更换网关版本或改变发布目录/符号链接的指向之前，必须先撤回到原入口；更新完成并核对原入口后，再以新的发布名重新生成规则并安装。取值组件启动会核规则声明的来源摘要；新组件检查失败时沿现有降级路径只提供原工具并记录原因，原网关自身启动失败仍会失败。现有检查不是覆盖网关版本及全部文件的技术闸，不能先替换底层文件再期望旧包装继续运行；本批只设计该技术闸，不改变五个运行文件。

每次安装使用新的 `--release` 发布名（传给打包器），包括上次失败后的重试。已有版本目录不会被覆盖或自动清理；它可能仍被任务、回执或历史引用使用，后清理由部署者确认。

主机安装/撤回由具备权限的运维身份运行：须能读取服务配置及状态，创建独立版本和本次 unit drop-in、将规则属主改为服务 User，并执行 systemctl daemon-reload/restart。通常使用该主机批准的 root/sudo 管理身份；不用普通 Hub 成员身份代替主机权限，也不在命令里携带 Hub 密钥。status 不执行修改，但能否读完整事实仍取决于主机权限；未知如实保留。预检后由 Boss 审阅，再执行 install；本地开发者不代替运维运行这些主机命令。

install/rollback开头强制euid=0，非root在读安装材料或写任何发布/单元文件前停止；preflight/status不要求root，读不到仍报未知。激活前收到INT/TERM/HUP时不修改服务，只可能留下惰性版本目录；激活后中断才走自动撤回。有pty的SSH断开可能送来HUP，无pty连接不能把断线等同收到HUP；安装阶段通过下一次不含配置的stderr阶段回执写失败发现控制管道断开，不承诺在阶段中即时发现。最后installed回执写失败只报告警告，不撤回已经核对健康的安装；不可捕获的强杀/断电不能承诺自动清理。撤回的自有进度文件只存发布名、配置内容摘要、阶段和PID，不存路径、配置或凭据；中断后再次执行同一rollback即可继续，status的rollback_pending会提示待完成。保留进度文件，不能用重新install代替继续撤回。

若新drop-in从未被daemon-reload加载，且实际MainPID确认原入口仍运行，只删除本次配置并reload，然后观察原PID，不重新restart。若确已换入口则按记录完成必要restart与稳定观察，重复rollback不会重复删除其它配置或重启已确认恢复的原服务。版本目录仍保留。

按已交回的主机事实，安装器和观测器统一使用**从现行ExecStart发现的服务专用解释器**（已报为3.12），不依赖登录PATH中的python3（已报为3.8）选解释器。框架原格式导出仍使用配置里的py38；服务及Hub格式导出沿服务解释器。完整路径只在主机内存中发现，不写死在材料里。status/rollback可用单独保留的安装器文件，不要求bundle。

建议整次安装/撤回在批准的sudo管理身份下运行，避免中途提权失败使自动撤回失去权限。不需要root的复制/独立目录创建/纯文件导出也在该事务内执行；必须root的步骤是unit目录写入、chown、daemon-reload/restart。这样新版本目录和五个代码文件归root，普通服务账户不能自行清理，后清理须另行由管理身份执行；runtime状态目录和两份规则单独赋给服务User，runtime为0700。现有配置、两行Environment和WorkingDirectory符号链接不改。运维使用已有口令通道，不假设sudo -n可用，不在命令或日志中写口令。

观测对所有主进程外进程一视同仁：短命读取/探测辅助进程也会使jobs非零，不把它猜成“可忽略的非作业”。重启会打断这类在途读取，安装前由运维停止持续调用方并保持窗口，再按当前事实重跑预检；不按进程名字豁免、不伪造空闲。

包装状态在版本目录runtime/status.json；装后必须是当前MainPID的mode=cell。mode=original表示服务已降级只提供旧工具，缺失或旧PID状态为未知，均不满足安装成功。status显示配置入口和组件状态是两件事，wrapped不代表已启用取值。

装后还调用随包固定摘要的probe.py：从现有配置的[listen]只读host/port及TLS配置是否存在，wildcard映射到回环，其余使用明确配置的IP；不接受任意URL/hostname，不读密钥/证书文件或代理环境，不带Authorization/Cookie，不跟随重定向。只发一次POST /mcp固定ping，未认证拒绝或匹配的RPC响应证明在答；404/重定向/HTML/超时不算成功，配置不可读也失败并自动撤回。HTTPS这一步仅探活，不代替固定CA身份和在线工具核对。preflight会核probe.py摘要，旧的无probe材料不能用于本次安装。

三种严格判断不放宽，预检给可区分的diagnostics和中文notes：cgroup_extra_processes（主进程外活动，短命读取也算）；request_clock_included（总清单含查询会推进的clock_floor），前后变化时报request_clock_changed且仍拒绝；task_alive_missing（任务存活锁缺失，保持未知）。额外时钟摘要仅供说明，不把时钟从总摘要剔除，也不补造锁或删除历史任务来绕过。

## 只读观测的边界

observe.py 不导入网关/框架模块、不调用网络接口。控制组中主进程之外的进程和任务存活锁用来证明“是否为零”；非零数可能重叠，不当作去重的业务作业总数。状态库以 SQLite 只读方式取租约事实，使用 boot identity 和 monotonic deadline 的原网关语义；缺文件、不可读、未知形状均返回未知，安装拒绝。

版本和工具清单来自源码静态声明，不是实际在线工具可用的证明。Hub 一侧的实时工具及预订核对由运维另做。目录清单包含文件字节与符号链接本身，不跟随链接去修改共享框架。请求历史摘要以持久请求事实为对象；启动审计队列投递的正常消耗不当作请求历史丢失。无全局停收闸，仍需运维维护批准的停收窗口；“此刻空闲”不能证明后面没有新请求。

## 导出及薄入口

export-contract 与 export-hub-contract 只读规则及已声明来源，核摘要，不执行框架/fixture/网关模块。任务 test_xlsx.py 只是薄入口，实际逐行函数仍来自原框架的 lib/test_xlsx.py，在私有全局字典中使用新规则。服务启动和任务构造核规则声明的来源；来源变化拒绝，不静默套用旧身份。运行真正用例时仍会使用原设备工厂，这与只读导出是两条路径。

主机 Python 和 systemd 的实际版本、路径形状、权限、真实设备输出与安装/撤回效果仍由运维确认；本机合成通过不等于已部署。

## 后续候选：预检与探测解释器

本节对应待验证的后续分支，不改变已批准安装的固定版本。预检先拒绝本单元目录中残留的撤回进度，按提示先续完原撤回，再对原网关做一次无凭据在线探测；配置或探测失败在复制、导出和激活之前停止。装后使用同一探测接口。健康安装最后一条进度回执无法写出时仅报告 receipt_warning，不再自动撤回。

探测按网关的 TOML 语义读取监听配置，缺省主机为127.0.0.1、端口为8910，接受网关支持的主机名和带引号端口；不导入网关、不读取证书或密钥文件、不打印配置。探测模块改用标准库 tomllib，要求Python3.11以上；沿用前述从ExecStart发现的服务专用Python3.12完整路径运行安装器和探测，不使用登录PATH中的Python3.8。框架自己的py38不变。开发运行probe测试同样需要3.11以上；此兼容前提须由集成方同步公共兼容说明后再交付。

### 合成测试的解释器选择

探测测试先读 `CIRCLE_HUB_TEST_PYTHON` 指向的已安装解释器，再在 PATH 查找Python3.11以上。都没有时，13项探测用例分别注明原因并跳过；跳过不算通过。需要实际验收时必须提供合格解释器，回报明确写运行、通过、失败和跳过数量。示例（占位，不是本机路径）：

```sh
CIRCLE_HUB_TEST_PYTHON="<已安装的Python3.11以上解释器>" node --test scripts/real/bed-side/install/probe.test.ts
```

该变量只用于测试，不影响Hub或网关的生产配置。安装器预检另核对ExecStart发现的服务解释器；低于3.11或无法确认时在写入前给出明确原因，不输出追溯或配置值。
