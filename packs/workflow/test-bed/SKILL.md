# 台架的登记、预订与释放

先读取任务包和管理员发布的台架清单，缺省 inputs.inventory 为 `{"external":"doc:doc:bed-topology"}`。
清单内容由管理员发布；用户登记只记归属，不修改清单。所有结论原样转述，保留
“Hub 记录里…（未排除本地操作）”，不能据此声称已经排除本地操作或已经停止网关作业。这个任务包不绑定产品线：不要给 start_run 的 product、version、build，也不要写进 parameters。搜索条件里的 need.build 仍是 need 的字段。

- `search`：可按 need.devices、need.build 搜索。不写 need 也展示每台设备的占用。
  主人或管理员能看到持有人名字；别人只看运行号、取得时刻和未终态作业号。构建来自声明，未核对。
- `facts`：从冻结清单计算监听、盲地址、后端、网段和装机声明，并保留当前占用的披露。
- `register`：参数 bed。登记前先确认这确实是用户自己的环境，再把清单中的台架登记到他名下。
  已有主人时停止登记，请管理员核对，不能以重试冒领。
- `acquire`：指定 bed 和 need.devices，需要地址时加 addresses。台架预订不限时长，租约由运行持有到释放。
  每个用例自己一条谱系；之后的计划、核验和派发以预订运行为前驱，沿用同一份租约。
- `release`：booking 为原预订运行号，开始运行的 predecessor 写同一号。用例的作业有终态以后释放，
  下一个用例再占。不在自己的谱系内就重新核对，不释放别人的预订。
- `force_release`：参数 bed、必填 reason，可选 devices。强制释放前先问用户，理由照原话写。
  不写 devices 时释放该台架下所有当前占用键（包含地址），写了则只释放指定设备。
  有未终态作业时按回执等它结束，或请管理员用 `circle-hub job status` 核对、用 `job dispose` 处置；
  本地释放停不了网关作业，不能用它替代远端核对。原血缘之后的派发会被围栏拒绝。
- `unregister`：参数 bed、必填 reason。由主人带理由注销；还有占用时先强制释放，或等它释放。

没有续期操作，不传 hours、need.hours 或 extend；旧调用会收到明确修正说明。
管理员用 `lease register <前缀> --owner <用户> --reason <理由>` 纠正冒领，或用 `lease unregister` 注销。

空闲原文示例：Hub 记录里空闲（未排除本地操作）。
