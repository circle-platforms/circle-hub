import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  Eye,
  FileText,
  Globe,
  KeyRound,
  Layers,
  Link2,
  LockKeyhole,
  MousePointer2,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Unplug,
  Workflow,
} from "lucide-react";
import { useDemo } from "./ui-context.tsx";
import {
  permitted,
  visibleTasks,
  phaseLabels,
  phaseTone,
  type Task,
} from "./domain.ts";
import {
  Badge,
  Button,
  Card,
  Checklist,
  Empty,
  JsonBlock,
  KeyValues,
  Metric,
  Modal,
  Notice,
  Progress,
  SectionLink,
  Sparkline,
  Tabs,
} from "./components.tsx";

function BrowserSurface({
  task,
  large = false,
}: {
  task: Task;
  large?: boolean;
}) {
  const step = task.browserStep ?? 0;
  return (
    <div className={`device-browser ${large ? "large" : ""}`}>
      <div className="device-browser-toolbar">
        <span className="window-dots">
          <i />
          <i />
          <i />
        </span>
        <div>
          <LockKeyhole size={11} />
          lbx-lab-01.example.test / management
        </div>
        <Badge>页面流程样例</Badge>
      </div>
      <div className="device-app">
        <aside>
          <div className="device-brand">
            <span className="circle-logo" />
            LBX
          </div>
          <small>产品管理页面</small>
          <div>概览</div>
          <div className={step >= 2 ? "active" : ""}>虚拟服务</div>
          <div>后端池</div>
          <div>证书</div>
          <div>运行日志</div>
        </aside>
        <section>
          {step === 0 ? (
            <div className="device-login">
              <KeyRound size={25} />
              <h3>等待受控登录</h3>
              <p>Agent 使用连接凭据引用，密码不进入会话。</p>
              <span>凭据通道与用户交互分别处理</span>
            </div>
          ) : step === 1 ? (
            <>
              <small>运行概览</small>
              <h3>测试设备 LBX-LAB-01</h3>
              <div className="device-metrics">
                <div>
                  <b>4</b>
                  <small>虚拟服务</small>
                </div>
                <div>
                  <b>2</b>
                  <small>后端池</small>
                </div>
                <div>
                  <b>1</b>
                  <small>待检查</small>
                </div>
              </div>
              <div className="device-notice">
                payments-lab 的业务响应存在差异，继续查看对应配置。
              </div>
            </>
          ) : (
            <>
              <div className="row gap">
                <small>虚拟服务 / 后端池</small>
                <Badge tone={step === 3 ? "green" : "amber"}>
                  {step === 3 ? "配置回读样例" : "待核对"}
                </Badge>
              </div>
              <h3>payments-lab</h3>
              <dl>
                <div>
                  <dt>后端地址</dt>
                  <dd>192.0.2.42 · 演示地址</dd>
                </div>
                <div>
                  <dt>健康检查间隔</dt>
                  <dd>{step === 3 ? "5" : "30"} 秒</dd>
                </div>
                <div>
                  <dt>连接超时</dt>
                  <dd>5 秒</dd>
                </div>
                <div>
                  <dt>配置来源</dt>
                  <dd>
                    {task.operation} · input-r{task.inputRevision}
                  </dd>
                </div>
              </dl>
              <div className={`device-notice ${step === 3 ? "success" : ""}`}>
                {step === 3
                  ? "页面样例已切换到变更后回读状态。业务恢复仍需独立观察。"
                  : "仅查看配置，没有进行真实变更。"}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function ExecutionPage() {
  const {
    state,
    context,
    act,
    focusTaskId,
    sceneRequested,
    openTask,
    openEvidence,
    go,
  } = useDemo();
  const [tab, setTab] = useState(sceneRequested ? "sessions" : "environments");
  const [selected, setSelected] = useState(focusTaskId);
  const [expanded, setExpanded] = useState(false);
  const tasks = visibleTasks(state, context);
  const task = tasks.find((t) => t.id === selected) ?? tasks[0];
  const canRead = permitted(context, "business.read");
  const canOperate = permitted(context, "platform.manage");
  const workers = state.workers.filter((w) =>
    context.environment === "lab"
      ? !w.id.startsWith("PROD")
      : w.id.startsWith("PROD"),
  );
  useEffect(() => {
    if (sceneRequested) {
      setSelected(focusTaskId);
      setTab("sessions");
    }
  }, [sceneRequested, focusTaskId]);
  if (!canRead && !canOperate)
    return (
      <Empty
        locked
        title="这个账号不能查看执行环境"
        description="执行现场和平台维护需要分别授权。"
      />
    );
  return (
    <>
      <Tabs
        tabs={[
          { id: "environments", label: "环境与节点" },
          { id: "sessions", label: "当前现场" },
          { id: "operations", label: "操作记录" },
          { id: "connections", label: "目标连接" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "environments" && (
        <>
          <div className="environment-strip">
            <div>
              <Server size={20} />
              <div>
                <b>中心服务 + 目标网络中的执行节点</b>
                <p>
                  任务留在服务端，工具在获准网络区域执行，现场与原始输出关联同一项工作。
                </p>
              </div>
            </div>
            <Badge tone="blue">
              {context.environment === "lab" ? "测试域" : "生产域"}
            </Badge>
          </div>
          <Card>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>执行节点</th>
                    <th>网络区域</th>
                    <th>状态</th>
                    <th>在途工作</th>
                    <th>心跳</th>
                    <th>CPU / 内存</th>
                    <th>维护</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <b>{w.id}</b>
                        <small>worker {w.version}</small>
                      </td>
                      <td>{w.region}</td>
                      <td>
                        <Badge
                          tone={
                            w.status === "online"
                              ? "green"
                              : w.status === "offline"
                                ? "red"
                                : "amber"
                          }
                        >
                          {w.status === "online"
                            ? "在线"
                            : w.status === "offline"
                              ? "连接中断"
                              : "排空中"}
                        </Badge>
                      </td>
                      <td>{w.tasks}</td>
                      <td>{w.heartbeat}</td>
                      <td>
                        <div className="resource-bars">
                          <span>CPU {w.cpu}%</span>
                          <Progress value={w.cpu} />
                          <span>内存 {w.memory}%</span>
                          <Progress value={w.memory} />
                        </div>
                      </td>
                      <td>
                        <Button
                          small
                          onClick={() =>
                            act({
                              type:
                                w.status === "offline"
                                  ? "workerReconnect"
                                  : "workerDrain",
                              id: w.id,
                            })
                          }
                        >
                          {w.status === "offline" ? "模拟恢复心跳" : "排空节点"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="two-col mt-20">
            <Card title="派发前检查">
              <Checklist
                items={[
                  { text: "节点身份、环境与网络范围有效", done: true },
                  { text: "任务授权不超过人员和服务的共同范围", done: true },
                  { text: "目标与输入修订一致", done: true },
                  { text: "资源租约与作用端检查有效", done: true },
                ]}
              />
            </Card>
            <Card title="断线与恢复">
              <div className="padded">
                <p className="paragraph">
                  节点断线后，任务不消失。已经发出的操作保持原身份，先核对远端结果，再决定后续动作。
                </p>
                <p className="paragraph">
                  排空只停止接收新工作，不删除在途任务、原始输出或待确认操作。
                </p>
                <Button small onClick={() => openTask("TSK-2090")}>
                  查看中断后的工作
                  <ArrowUpRight size={13} />
                </Button>
              </div>
            </Card>
          </div>
        </>
      )}
      {tab === "sessions" &&
        (canRead && task ? (
          <>
            <div className="toolbar">
              <div className="row gap">
                <select
                  aria-label="执行现场对应任务"
                  value={task.id}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
                <Badge tone={phaseTone[task.phase]}>
                  {phaseLabels[task.phase]}
                </Badge>
              </div>
              <Button small onClick={() => openTask(task.id)}>
                回到这项工作
                <ArrowUpRight size={13} />
              </Button>
            </div>
            <div className="session-binding">
              <span>
                工作 <code>{task.id}</code>
              </span>
              <span>
                操作 <code>{task.operation}</code>
              </span>
              <span>
                输入 <code>r{task.inputRevision}</code>
              </span>
              <span>
                当前控制 <b>{task.controller === "human" ? "人员" : "Agent"}</b>
              </span>
              <span className="session-binding-action">
                <Button
                  small
                  onClick={() =>
                    act({
                      type:
                        task.controller === "human"
                          ? "returnControl"
                          : "takeover",
                      id: task.id,
                    })
                  }
                >
                  {task.controller === "human" ? "交还控制权" : "接管现场"}
                </Button>
              </span>
            </div>
            <div className="scene-columns">
              <Card
                title={
                  <>
                    <Terminal size={15} />
                    SSH · {task.session || "尚未建立"}
                  </>
                }
                extra={<Badge>同一执行会话</Badge>}
              >
                <div className="terminal-scene">
                  <div className="terminal-meta">
                    <span>LBX-LAB-01 / {task.worker}</span>
                    <span>UTF-8 · PTY · 合成终端</span>
                  </div>
                  <pre>
                    <span className="terminal-muted">
                      $ connect --profile lab-readonly
                    </span>
                    {"\n"}
                    <span className="terminal-green">
                      target: LBX-LAB-01 · version 8.4.2
                    </span>
                    {"\n"}host identity:{" "}
                    {task.targetChanged
                      ? "CHANGED / write blocked"
                      : "matched-demo-identity"}
                    {"\n\n"}
                    <span className="terminal-muted">
                      LBX-LAB-01 &gt; show monitor pool-payments
                    </span>
                    {"\n"}monitor.interval: 30{"\n"}backend.timeout: 5{"\n"}
                    pool.member: 192.0.2.42{"\n"}operation: {task.operation}
                    {"\n\n"}
                    <span className="terminal-amber">
                      [sample output — no device connection]
                    </span>
                    {"\n"}
                    <span className="terminal-cursor">▍</span>
                  </pre>
                </div>
                <div className="scene-actions">
                  <Button
                    small
                    onClick={() =>
                      task.evidence[0] && openEvidence(task.evidence[0])
                    }
                  >
                    完整输入输出
                  </Button>
                  <Button
                    small
                    onClick={() => act({ type: "identityChange", id: task.id })}
                  >
                    模拟目标身份变化
                  </Button>
                </div>
              </Card>
              <Card
                title={
                  <>
                    <Globe size={15} />
                    Web · WEB-
                    {task.id === "TSK-2084" ? "012" : task.id.slice(4)}
                  </>
                }
                extra={
                  <button
                    className="text-link"
                    onClick={() => setExpanded(true)}
                  >
                    单独查看
                    <ArrowUpRight size={12} />
                  </button>
                }
              >
                <BrowserSurface task={task} />
                <div className="scene-actions">
                  <span className="muted">
                    同一页面流程 · {(task.browserStep ?? 0) + 1} / 4
                  </span>
                  <Button
                    small
                    onClick={() => act({ type: "webStep", id: task.id })}
                  >
                    演示下一步
                  </Button>
                </div>
              </Card>
            </div>
            <Notice>
              观察与控制分别授权。接管后 Agent
              等待；交还控制权后沿用原会话和任务。远端停止与工具返回都需要独立记录。
            </Notice>
            {task.targetChanged && (
              <Notice tone="amber">
                目标身份发生变化，原委托不能继续作用。需要重新确认目标与连接，不能直接重发写入。
              </Notice>
            )}
            <div className="two-col mt-20">
              <Card title="停止与核对">
                <div className="padded">
                  <p className="paragraph">
                    先记录停止请求，再等执行端与现场观察。不会因聊天结束或本地断线就显示远端已经停止。
                  </p>
                  <div className="row gap">
                    <Button
                      small
                      onClick={() => act({ type: "cancel", id: task.id })}
                      disabled={["done", "stopped"].includes(task.phase)}
                    >
                      请求停止
                    </Button>
                    <Button
                      small
                      onClick={() => act({ type: "reconcile", id: task.id })}
                    >
                      模拟独立核对
                    </Button>
                  </div>
                  <div className="stop-stages">
                    <span
                      className={
                        task.phase === "stopping" || task.phase === "stopped"
                          ? "done"
                          : ""
                      }
                    >
                      已请求
                    </span>
                    <ArrowRight size={12} />
                    <span className={task.phase === "stopped" ? "done" : ""}>
                      执行端回报
                    </span>
                    <ArrowRight size={12} />
                    <span className={task.phase === "stopped" ? "done" : ""}>
                      观察确认
                    </span>
                  </div>
                </div>
              </Card>
              <Card title="这次现场的授权">
                <div className="padded">
                  <KeyValues
                    items={[
                      {
                        label: "人员 / 任务",
                        value: `${task.owner} / ${task.id}`,
                      },
                      { label: "目标", value: "LBX-LAB-01 / 测试域" },
                      {
                        label: "连接方式",
                        value: "SSH 跳转链 / 受控 Web 会话",
                      },
                      { label: "租约", value: "fence-56（演示记录）" },
                      { label: "凭据", value: "只保存引用，不进入聊天和日志" },
                    ]}
                  />
                </div>
              </Card>
            </div>
            {expanded && (
              <Modal
                title="同一 Web 执行会话"
                subtitle={`WEB-${task.id === "TSK-2084" ? "012" : task.id.slice(4)} · ${task.operation} · ${task.id}`}
                wide
                onClose={() => setExpanded(false)}
              >
                <BrowserSurface task={task} large />
                <div className="dialog-actions">
                  <Button
                    small
                    onClick={() => act({ type: "webStep", id: task.id })}
                  >
                    演示下一步
                  </Button>
                </div>
                <Notice>
                  这里与现场面板使用同一个会话状态。正式的内嵌显示和外部浏览器都需要访问获准的同一
                  D 会话。
                </Notice>
              </Modal>
            )}
          </>
        ) : (
          <Empty
            locked
            title="当前身份不能读取业务现场"
            description="平台运维可以维护节点，但不默认查看 SSH 输出、产品页面或设备配置。"
          />
        ))}
      {tab === "operations" && (
        <Card title="独立操作记录">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>操作</th>
                  <th>关联工作</th>
                  <th>执行节点</th>
                  <th>当前状态</th>
                  <th>输入绑定</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr
                    key={t.id}
                    className="clickable"
                    onClick={() => openTask(t.id)}
                  >
                    <td>
                      <b>{t.operation}</b>
                      <small>{t.session || "无终端会话"}</small>
                    </td>
                    <td>
                      {t.title}
                      <small>{t.id}</small>
                    </td>
                    <td>{t.worker}</td>
                    <td>
                      <Badge tone={phaseTone[t.phase]}>
                        {phaseLabels[t.phase]}
                      </Badge>
                    </td>
                    <td>input-r{t.inputRevision}</td>
                    <td>
                      {t.phase === "unknown"
                        ? "待查原操作，未重发"
                        : t.phase === "stopping"
                          ? "停止尚未确认"
                          : t.phase === "stopped"
                            ? "合成观察已确认"
                            : "保留输入输出"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!tasks.length && (
            <Empty
              title="没有可读的业务操作"
              description="当前角色只查看平台节点与服务状态。"
            />
          )}
        </Card>
      )}
      {tab === "connections" && (
        <div className="two-col">
          <Card title="测试域 SSH 连接方案">
            <div className="padded">
              <div className="network-hop">
                <span>执行节点</span>
                <ArrowRight size={13} />
                <span>跳转机</span>
                <ArrowRight size={13} />
                <span>目标设备</span>
              </div>
              <KeyValues
                items={[
                  { label: "连接配置", value: "lab-readonly（合成配置）" },
                  {
                    label: "目标身份",
                    value: "设备标识 + 软件版本 + 主机密钥",
                  },
                  { label: "终端", value: "PTY、分页、原始字节与命令边界" },
                  {
                    label: "实际作用",
                    value: "每次执行前核对授权、目标和租约",
                  },
                  { label: "异常", value: "未知结果、身份变化和断线分别处理" },
                ]}
              />
            </div>
          </Card>
          <Card title="产品 Web 会话">
            <div className="padded">
              <KeyValues
                items={[
                  { label: "会话拥有者", value: "执行服务 D" },
                  {
                    label: "用户显示",
                    value: "Circle 内嵌视图或获准的同会话外部查看",
                  },
                  { label: "控制", value: "查看、接管与继续分开授权" },
                  { label: "登录", value: "凭据 / MFA 使用受控交互通道" },
                  { label: "隔离", value: "独立工作区、浏览器配置和作用范围" },
                ]}
              />
              <Notice>
                不共享普通用户浏览器配置，不把原始调试端口提供给普通用户。
              </Notice>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

export function SchedulesPage() {
  const { state, context, act, openTask, openAgent } = useDemo();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState("rules");
  const schedule = state.schedules.find((s) => s.id === selected);
  const tasks = visibleTasks(state, context);
  if (!permitted(context, "business.read"))
    return (
      <Empty
        locked
        title="这个账号不能查看业务自动化"
        description="固定规则与每次运行按项目、服务身份和目标范围管理。"
      />
    );
  return (
    <>
      <Tabs
        tabs={[
          { id: "rules", label: "自动化规则" },
          { id: "history", label: "触发与运行历史" },
          { id: "long", label: "长期工作" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "rules" && (
        <>
          <div className="automation-intro">
            <Clock3 size={22} />
            <div>
              <b>一次定义，按规则触发独立工作</b>
              <p>
                定时、手工或事件触发使用固定的
                Agent、模板与服务身份。暂停规则不取消已经运行的工作。
              </p>
            </div>
            <Badge>调度交互提案</Badge>
          </div>
          <Card>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>规则</th>
                    <th>Agent / 模板</th>
                    <th>触发</th>
                    <th>下次运行</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {state.schedules.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <button
                          className="table-title"
                          onClick={() => setSelected(s.id)}
                        >
                          {s.title}
                        </button>
                        <small>
                          {s.id} · {s.product}
                        </small>
                      </td>
                      <td>
                        {s.id === "SCH-102"
                          ? "稳定性测试 Agent"
                          : s.id === "SCH-101"
                            ? "配置巡检 Agent"
                            : "知识同步流程"}
                        <small>
                          {s.method} {s.version}
                        </small>
                      </td>
                      <td>
                        <code>{s.cron}</code>
                        <small>{s.timezone}</small>
                      </td>
                      <td>{s.nextRun}</td>
                      <td>
                        <Badge tone={s.enabled ? "green" : "neutral"}>
                          {s.enabled ? "已启用" : "已暂停"}
                        </Badge>
                      </td>
                      <td>
                        <div className="row gap">
                          <Button
                            small
                            onClick={() =>
                              act({ type: "scheduleRun", id: s.id })
                            }
                          >
                            <Play size={12} />
                            立即运行
                          </Button>
                          <Button
                            small
                            onClick={() =>
                              act({ type: "scheduleToggle", id: s.id })
                            }
                          >
                            {s.enabled ? "暂停" : "启用"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Notice>
            此处展示规则、时区、重叠和补跑策略；没有实际后台计时器。每次触发的工作仍有独立任务、运行记录和证据。
          </Notice>
        </>
      )}
      {tab === "history" && (
        <Card title="每次触发都会形成独立运行">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>工作</th>
                  <th>触发来源</th>
                  <th>固定版本</th>
                  <th>状态</th>
                  <th>证据</th>
                </tr>
              </thead>
              <tbody>
                {state.runs
                  .filter(
                    (r) =>
                      tasks.some((t) => t.id === r.taskId) &&
                      (r.trigger.startsWith("SCH") ||
                        tasks.find((t) => t.id === r.taskId)?.kind ===
                          "scheduled"),
                  )
                  .map((r) => (
                    <tr
                      key={r.id}
                      className="clickable"
                      onClick={() => openTask(r.taskId)}
                    >
                      <td>
                        <b>{tasks.find((t) => t.id === r.taskId)?.title}</b>
                        <small>
                          {r.id} · {r.taskId}
                        </small>
                      </td>
                      <td>{r.trigger}</td>
                      <td>
                        Agent {r.agentVersion}
                        <small>input-r{r.inputRevision}</small>
                      </td>
                      <td>
                        <Badge
                          tone={
                            phaseTone[r.status as keyof typeof phaseTone] ??
                            "neutral"
                          }
                        >
                          {phaseLabels[r.status as keyof typeof phaseLabels] ??
                            r.status}
                        </Badge>
                      </td>
                      <td>进入任务查看</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {tab === "long" && (
        <>
          <div className="long-task-grid">
            {tasks
              .filter((t) => t.kind === "long")
              .map((t) => (
                <Card key={t.id}>
                  <div className="long-task-card">
                    <div className="row gap">
                      <Clock3 size={21} />
                      <div>
                        <h3>{t.title}</h3>
                        <p>
                          {t.id} · {t.agentVersion}
                        </p>
                      </div>
                      <Badge tone={phaseTone[t.phase]}>
                        {phaseLabels[t.phase]}
                      </Badge>
                    </div>
                    <div className="long-window">
                      <b>{t.duration}</b>
                      <span>/ 72 小时观察窗口 · 合成样例</span>
                    </div>
                    <Progress value={t.progress} />
                    <div className="long-facts">
                      <div>
                        <small>最近样本</small>
                        <b>第 338 个</b>
                      </div>
                      <div>
                        <small>执行节点</small>
                        <b>{t.worker}</b>
                      </div>
                      <div>
                        <small>下次动作</small>
                        <b>按采样计划继续</b>
                      </div>
                    </div>
                    <p className="paragraph">
                      采样由固定脚本推进，出现异常再进入 Agent
                      分析。用户断线、单次运行结束或现场会话到期都不结束这项持续工作。
                    </p>
                    <div className="row gap">
                      <Button small onClick={() => openTask(t.id)}>
                        查看工作与证据
                      </Button>
                      <Button
                        small
                        onClick={() => act({ type: "cancel", id: t.id })}
                      >
                        请求停止
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
          </div>
          <div className="two-col mt-20">
            <Card title="长期保存的状态">
              <Checklist
                items={[
                  { text: "目标、输入与知识 / 方法版本", done: true },
                  { text: "已完成步骤、计时与唤醒记录", done: true },
                  { text: "人工回应、待确认操作和预算", done: true },
                  { text: "原始输出与独立证据引用", done: true },
                ]}
              />
            </Card>
            <Card title="单次执行可以恢复">
              <div className="padded">
                <p className="paragraph">
                  长任务保存在 C。一次运行、SSH
                  或浏览器会话属于执行现场，可以中断、重建或更换节点。
                </p>
                <p className="paragraph">
                  恢复时先检查旧操作与副作用，再继续任务；不从聊天文本猜测执行已经成功。
                </p>
              </div>
            </Card>
          </div>
        </>
      )}
      {schedule && (
        <Modal
          title={schedule.title}
          subtitle={`${schedule.id} · 固定规则与每次运行分开`}
          wide
          onClose={() => setSelected(null)}
        >
          <KeyValues
            items={[
              {
                label: "触发规则",
                value: `${schedule.cron} / ${schedule.timezone}`,
              },
              {
                label: "Agent / 方法",
                value: `${schedule.method} ${schedule.version}`,
              },
              { label: "服务身份", value: schedule.principal },
              { label: "目标", value: "当前研发项目的授权测试设备" },
              { label: "重叠策略", value: schedule.overlap },
              { label: "补跑策略", value: schedule.catchup },
              { label: "执行上限", value: schedule.maxDuration },
              {
                label: "失败处理",
                value: "保存输入输出，等待核对或通知负责人",
              },
              { label: "通知", value: "进入“待我处理”，只通知获准人员" },
            ]}
          />
          <Notice>
            修改规则影响后续触发。已有工作继续使用创建时固定的版本和范围。
          </Notice>
          <div className="dialog-actions">
            <Button
              onClick={() => {
                setSelected(null);
                openAgent(schedule.id === "SCH-102" ? "AGT-004" : "AGT-002");
              }}
            >
              查看 Agent
            </Button>
            <Button
              primary
              onClick={() => {
                const r = act({ type: "scheduleRun", id: schedule.id });
                if (r.ok && r.taskId) {
                  setSelected(null);
                  openTask(r.taskId);
                }
              }}
            >
              生成一次演示运行
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function DiagnosisPage() {
  const { context, openTask, openEvidence, openDocument } = useDemo();
  const [layer, setLayer] = useState(4);
  if (!permitted(context, "business.read"))
    return (
      <Empty
        locked
        title="当前身份不能读取诊断内容"
        description="业务路径、配置与流量证据沿用项目授权范围。"
      />
    );
  const layers = [
    {
      title: "链路与物理状态",
      check: "链路、接口错误、速率与介质",
      state: "未采集",
      tone: "neutral",
      result: "本例没有物理链路或介质证据。",
    },
    {
      title: "交换与邻居",
      check: "VLAN、ARP / ND、转发路径",
      state: "待核对",
      tone: "amber",
      result: "需要从目标网络中的观察点采集，不使用旧拓扑直接判定。",
    },
    {
      title: "路由与回程",
      check: "路由、NAT、非对称路径",
      state: "待核对",
      tone: "amber",
      result: "回程流量没有取得，不能排除相关原因。",
    },
    {
      title: "传输与连接",
      check: "TCP、丢包、时延与重传",
      state: "部分记录",
      tone: "blue",
      result: "合成探针显示后端直连可达；没有完整流量记录。",
    },
    {
      title: "TLS 与域名",
      check: "DNS、SNI、证书与两段握手",
      state: "原因候选",
      tone: "violet",
      result: "SNI 或两段 TLS 设置是候选，需要对应握手与配置证据。",
    },
    {
      title: "应用与产品行为",
      check: "HTTP、转发、健康检查与后端",
      state: "已有示例",
      tone: "blue",
      result: "业务入口 502、管理 200、后端 200，不能用管理可达代替业务恢复。",
    },
  ];
  return (
    <>
      <Card
        title="同一条业务的不同观察点"
        extra={<Badge>TSK-2084 · 合成拓扑</Badge>}
      >
        <div className="business-path">
          {[
            {
              name: "用户侧",
              kind: "请求域名 / TLS",
              state: "业务 502",
              tone: "red",
            },
            {
              name: "安全网关",
              kind: "策略 / NAT / 路由",
              state: "范围待核对",
              tone: "amber",
            },
            {
              name: "LBX 设备",
              kind: "虚拟服务 / pool",
              state: "管理可达",
              tone: "blue",
            },
            {
              name: "后端服务",
              kind: "连接 / TLS / HTTP",
              state: "直连 200",
              tone: "green",
            },
          ].map((n, i) => (
            <div className="path-node-wrap" key={n.name}>
              <div className="path-node">
                <Network size={21} />
                <b>{n.name}</b>
                <small>{n.kind}</small>
                <Badge tone={n.tone}>{n.state}</Badge>
              </div>
              {i < 3 && <ArrowRight size={18} />}
            </div>
          ))}
        </div>
      </Card>
      <div className="diagnostic-layout mt-20">
        <Card title="按层查看调查范围">
          <div className="diagnostic-layers">
            {layers.map((l, i) => (
              <button
                key={l.title}
                className={layer === i ? "active" : ""}
                onClick={() => setLayer(i)}
              >
                <span>{i + 1}</span>
                <div>
                  <b>{l.title}</b>
                  <small>{l.check}</small>
                </div>
                <Badge tone={l.tone}>{l.state}</Badge>
              </button>
            ))}
          </div>
        </Card>
        <Card title={layers[layer].title}>
          <div className="padded">
            <Badge tone={layers[layer].tone}>{layers[layer].state}</Badge>
            <p className="paragraph">{layers[layer].result}</p>
            <KeyValues
              items={[
                { label: "观察位置", value: "客户端、设备、后端分别登记" },
                { label: "采集范围", value: layers[layer].check },
                {
                  label: "已取得记录",
                  value:
                    layer === 5
                      ? "EV-301 / EV-302 / EV-303"
                      : "根据当前层逐项核对",
                },
                {
                  label: "判断边界",
                  value: "观察、字段差异和原因判断分别保存",
                },
              ]}
            />
            <div className="row gap">
              <Button small onClick={() => openEvidence("EV-302")}>
                打开原始观察
              </Button>
              <Button small onClick={() => openDocument("DOC-104")}>
                相关产品资料
              </Button>
            </div>
            <Notice tone="amber">
              未采集、冲突和未确认原因都留在调查中，不用肯定的措辞补足缺少的证据。
            </Notice>
          </div>
        </Card>
      </div>
      <div className="diagnosis-footer">
        <div>
          <b>接下来需要什么</b>
          <p>
            明确时段与观察点，采集回程和两段
            TLS，再检查原因候选是否解释全部现象。
          </p>
        </div>
        <Button onClick={() => openTask("TSK-2084")}>
          回到持续调查
          <ArrowUpRight size={13} />
        </Button>
      </div>
    </>
  );
}
