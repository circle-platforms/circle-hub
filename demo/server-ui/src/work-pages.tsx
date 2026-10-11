import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Download,
  FileText,
  GitCompare,
  Paperclip,
  Play,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useDemo } from "./ui-context.tsx";
import {
  Badge,
  Button,
  Card,
  Empty,
  JsonBlock,
  KeyValues,
  Notice,
  Progress,
  Tabs,
} from "./components.tsx";
import {
  permitted,
  phaseLabels,
  phaseTone,
  roles,
  type Task,
} from "./domain.ts";
import {
  maintenanceWork,
  outlineRows,
  pendingFindings,
  reviewFindings,
  scenarios,
  workflowFor,
  type WorkScenario,
} from "./workflows.ts";
import {
  base64ToBytes,
  buildOutlineWorkbook,
  bytesToBase64,
  downloadBytes,
  downloadJson,
  rowValues,
} from "./workflow-files.ts";

export function ScenarioWork({
  task,
  onBack,
}: {
  task: Task;
  onBack: () => void;
}) {
  const { context, state, act, openScene, openEvidence, notify } = useDemo();
  const scenario = workflowFor(task)!;
  const work = task.workflowState!;
  const [tab, setTab] = useState("work");
  const [response, setResponse] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canRespond = permitted(context, "task.respond");
  const findings = pendingFindings(task);
  const receipt = work.artifactReceipt;
  let outline: ReturnType<typeof outlineRows> | undefined;
  let parseError = "";
  if (scenario.id === "outline") {
    try {
      outline = outlineRows(work.materials[0]?.text ?? "");
    } catch (e) {
      parseError = String(e);
    }
  }
  const build = async (download = false) => {
    if (
      download &&
      receipt?.checked &&
      receipt.inputRevision === task.inputRevision &&
      work.workbookBase64
    ) {
      downloadBytes(
        `结构清单-input-r${task.inputRevision}.xlsx`,
        base64ToBytes(work.workbookBase64),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      return;
    }
    if (!canRespond) return;
    setBusy(true);
    try {
      const result = await buildOutlineWorkbook(
        work.materials[0].text,
        task.inputRevision,
      );
      const saved = act({
        type: "recordWorkbook",
        id: task.id,
        receipt: result.receipt,
        base64: bytesToBase64(result.bytes),
      });
      if (download && saved.ok)
        downloadBytes(
          `结构清单-input-r${task.inputRevision}.xlsx`,
          result.bytes,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const approval = scenario.approval;
  return (
    <div className="task-detail scenario-work">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        返回任务列表
      </button>
      <div className="detail-title">
        <div>
          <div className="row gap">
            <code>{task.id}</code>
            <Badge tone={phaseTone[task.phase]}>
              {phaseLabels[task.phase]}
            </Badge>
            <Badge>专用工作流程</Badge>
          </div>
          <h2>{scenario.title}</h2>
          <p>
            {task.product} · {task.owner} · input-r{task.inputRevision}
          </p>
        </div>
        <div className="row gap">
          <Button
            small
            onClick={() => act({ type: "cancel", id: task.id })}
            disabled={
              !canRespond ||
              ["done", "stopped", "stopping"].includes(task.phase)
            }
          >
            请求停止
          </Button>
          <Button
            small
            primary
            disabled={
              !canRespond ||
              ["done", "stopped", "review", "stopping", "unknown"].includes(
                task.phase,
              ) ||
              (task.phase === "waiting" && !!scenario.clarification)
            }
            onClick={() => act({ type: "advance", id: task.id })}
          >
            <Play size={13} />
            {task.phase === "done"
              ? "已交付演示结果"
              : `继续：${scenario.steps[Math.min(task.step, scenario.steps.length - 1)]}`}
          </Button>
        </div>
      </div>
      <div className="scenario-layout">
        <main>
          <div className="workflow-rail">
            {scenario.steps.map((s, i) => (
              <div
                key={s}
                className={
                  i < task.step ? "finished" : i === task.step ? "current" : ""
                }
              >
                <span>{i < task.step ? <Check size={12} /> : i + 1}</span>
                <p>{s}</p>
              </div>
            ))}
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "work", label: "工作内容" },
              {
                id: "materials",
                label: "原件与输入",
                count: work.materials.length,
              },
              { id: "runs", label: "运行与事件" },
              { id: "delivery", label: "交付与未确认" },
            ]}
          />
          {task.phase === "waiting" && scenario.clarification && (
            <Card title="需要你补充的具体信息">
              <p className="paragraph">{scenario.clarification}</p>
              <textarea
                className="work-response"
                aria-label="澄清回应"
                placeholder="说明条件或补充依据；也可以明确当前尚未取得"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                disabled={!canRespond}
              />
              <Button
                primary
                small
                disabled={!canRespond || !response.trim()}
                onClick={() => {
                  const r = act({
                    type: "revise",
                    id: task.id,
                    text: response,
                  });
                  if (r.ok) setResponse("");
                }}
              >
                保存回应并继续
              </Button>
              <p className="card-note">
                回应形成新输入修订；模型判断仍是示例，不会因为填写了文字就认定条件成立。
              </p>
            </Card>
          )}
          {task.phase === "review" && approval && (
            <Card title={approval.title} extra={<ShieldCheck size={18} />}>
              <p className="paragraph">{approval.scope}</p>
              <KeyValues
                items={[
                  { label: "本次输入", value: `input-r${task.inputRevision}` },
                  { label: "原件/版本", value: task.snapshot },
                  { label: "决定人员", value: "陈昕 · 业务审批" },
                ]}
              />
              <div className="row gap">
                <Button
                  small
                  onClick={() => act({ type: "reject", id: task.id })}
                  disabled={!permitted(context, "task.approve")}
                >
                  不批准
                </Button>
                <Button
                  primary
                  small
                  onClick={() => act({ type: "approve", id: task.id })}
                  disabled={!permitted(context, "task.approve")}
                >
                  批准本次动作
                </Button>
              </div>
              <p className="card-note">
                从顶部切换业务审批演示身份。信息和目标变化后需要重新决定。
              </p>
            </Card>
          )}
          {tab === "work" && (
            <>
              {scenario.id === "review" ? (
                <>
                  <Card
                    title="逐条评审意见"
                    extra={<Badge>固定合成意见</Badge>}
                  >
                    {task.step < 3 && (
                      <Notice>
                        先推进到「逐条处理评审意见」，查看本轮意见；原用例和规范已经可以打开。
                      </Notice>
                    )}
                    {task.step >= 3 &&
                      findings.map((f) => {
                        const decision = work.decisions.find(
                          (d) =>
                            d.findingId === f.id &&
                            d.revision === task.inputRevision,
                        );
                        return (
                          <article className="finding" key={f.id}>
                            <div className="row gap">
                              <code>{f.id}</code>
                              <b>{f.location}</b>
                              <Badge>{f.kind}</Badge>
                              {decision && (
                                <Badge tone="green">
                                  {decision.choice === "accept"
                                    ? "接受"
                                    : "驳回"}{" "}
                                  · r{decision.revision}
                                </Badge>
                              )}
                            </div>
                            <blockquote>{f.original}</blockquote>
                            <p>{f.explanation}</p>
                            <div className="finding-source">
                              <BookOpen size={13} />
                              {f.source}
                            </div>
                            <div className="finding-proposal">
                              <small>建议修改</small>
                              <p>{f.proposed}</p>
                            </div>
                            <input
                              aria-label={`${f.id} 处理理由`}
                              placeholder="记录接受或驳回的理由"
                              value={reasons[f.id] ?? decision?.reason ?? ""}
                              onChange={(e) =>
                                setReasons({
                                  ...reasons,
                                  [f.id]: e.target.value,
                                })
                              }
                              disabled={!canRespond}
                            />
                            <div className="row gap">
                              <Button
                                small
                                disabled={
                                  !canRespond ||
                                  !(reasons[f.id] ?? decision?.reason)?.trim()
                                }
                                onClick={() =>
                                  act({
                                    type: "findingDecision",
                                    id: task.id,
                                    findingId: f.id,
                                    choice: "accept",
                                    reason:
                                      reasons[f.id] ?? decision?.reason ?? "",
                                  })
                                }
                              >
                                接受建议
                              </Button>
                              <Button
                                small
                                disabled={
                                  !canRespond ||
                                  !(reasons[f.id] ?? decision?.reason)?.trim()
                                }
                                onClick={() =>
                                  act({
                                    type: "findingDecision",
                                    id: task.id,
                                    findingId: f.id,
                                    choice: "dismiss",
                                    reason:
                                      reasons[f.id] ?? decision?.reason ?? "",
                                  })
                                }
                              >
                                驳回并保留理由
                              </Button>
                            </div>
                          </article>
                        );
                      })}
                    {!!work.appliedRevision && (
                      <Notice tone="green">
                        已形成 input-r{work.appliedRevision}{" "}
                        并进入复审演示。接受项已改写；驳回意见和原评审保留在运行/事件中。通过阈值等缺少的产品依据仍待确认。
                      </Notice>
                    )}
                  </Card>
                  {task.step >= 3 && !work.appliedRevision && (
                    <Card title="修改前后对比">
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>位置</th>
                              <th>修改前</th>
                              <th>所接受的修改</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reviewFindings
                              .filter((f) =>
                                work.decisions.some(
                                  (d) =>
                                    d.findingId === f.id &&
                                    d.choice === "accept",
                                ),
                              )
                              .map((f) => (
                                <tr key={f.id}>
                                  <td>{f.location}</td>
                                  <td>{f.original}</td>
                                  <td>{f.proposed}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                      <Button
                        small
                        primary
                        disabled={
                          !canRespond ||
                          work.decisions.length !== reviewFindings.length ||
                          !work.decisions.some((d) => d.choice === "accept")
                        }
                        onClick={() =>
                          act({ type: "applyReviewEdits", id: task.id })
                        }
                      >
                        <GitCompare size={14} />
                        应用演示修改并复审
                      </Button>
                    </Card>
                  )}
                </>
              ) : scenario.id === "outline" ? (
                <>
                  <Card
                    title="原节点 → Excel 行映射"
                    extra={<Badge>七列结构合同 V1</Badge>}
                  >
                    {parseError ? (
                      <Notice tone="amber">{parseError}</Notice>
                    ) : (
                      <div className="table-wrap">
                        <table className="outline-table">
                          <thead>
                            <tr>
                              {scenario.columns.map((c) => (
                                <th key={c}>{c}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {outline?.rows.map((r) => (
                              <tr key={r.id}>
                                {rowValues(r).map((v, i) => (
                                  <td key={i}>{v}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="card-note">
                      根节点与一级模块用于分组；深度 ≥ 2
                      的节点按深度优先成行。层级深度写入数值单元格。
                    </p>
                    {!!outline?.unmapped.length && (
                      <Notice tone="amber">
                        部分映射：{outline.unmapped.join("；")}
                        。清单随工作簿保留，不能声称完整编译。
                      </Notice>
                    )}
                  </Card>
                  <Card title="工作簿与程序检查">
                    <KeyValues
                      items={[
                        { label: "工作表", value: "用例清单 / 说明" },
                        {
                          label: "映射行数",
                          value: outline?.rows.length ?? "解析失败",
                        },
                        {
                          label: "读回检查",
                          value:
                            receipt?.checked &&
                            receipt.inputRevision === task.inputRevision
                              ? "本修订检查通过"
                              : "尚未运行",
                        },
                        {
                          label: "源 SHA-256",
                          value: receipt?.sourceSha256 ?? "生成时计算",
                        },
                        {
                          label: "产物 SHA-256",
                          value: receipt?.artifactSha256 ?? "生成时计算",
                        },
                      ]}
                    />
                    <Button
                      primary
                      small
                      disabled={
                        !canRespond || busy || !!parseError || task.step < 3
                      }
                      onClick={() => build()}
                    >
                      {busy ? "正在生成与读回…" : "生成结构工作簿并检查"}
                    </Button>
                    <p className="card-note">
                      完成这项检查后再推进交付。此转换不补造测试命令、步骤或通过判据。
                    </p>
                  </Card>
                </>
              ) : (
                <>
                  <Card
                    title={`${scenario.title} · 专业结果视图`}
                    extra={<Badge>合成结果预览</Badge>}
                  >
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {scenario.columns.map((c) => (
                              <th key={c}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {scenario.rows.map((r, i) => (
                            <tr key={i}>
                              {r.map((c, j) => (
                                <td key={j}>{c}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="card-note">
                      这是流程中应出现的结果样例。查看样例不表示任务已执行或交付。
                    </p>
                  </Card>
                  {scenario.scene === "workspace" && (
                    <Card title="隔离工作区与修改差异">
                      <pre className="code-diff">{`// 合成仓库 product-demo / example-a1\n- const timeout = Number(args.timeout ?? 3000);\n+ const timeout = parsePositiveTimeout(args.timeout ?? 3000);\n+ if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("invalid timeout");\n\n// 仅用于审阅流程，未修改真实仓库或创建 PR`}</pre>
                    </Card>
                  )}
                  {scenario.scene === "lab" && (
                    <Card title="环境、观察点与恢复">
                      <div className="lab-path">
                        <span>客户端</span>
                        <ArrowRight size={14} />
                        <span>测试网关</span>
                        <ArrowRight size={14} />
                        <span>LBX 主备</span>
                        <ArrowRight size={14} />
                        <span>后端</span>
                      </div>
                      <KeyValues
                        items={[
                          {
                            label: "观察",
                            value: "客户端、产品与后端记录分别保留",
                          },
                          {
                            label: "窗口",
                            value:
                              scenario.id === "performance"
                                ? "72 小时计划；当前只显示合成样本"
                                : "按测试计划冻结",
                          },
                          {
                            label: "清理",
                            value: "进程、连接、配置和资源残留分别检查",
                          },
                        ]}
                      />
                    </Card>
                  )}
                </>
              )}
              <Notice tone="amber">{scenario.boundary}</Notice>
            </>
          )}
          {tab === "materials" && (
            <>
              <Card title="当前输入与原件">
                <p className="paragraph">{task.prompt}</p>
                {work.materials.map((m, i) => (
                  <details className="material-detail" key={i} open={i === 0}>
                    <summary>
                      <FileText size={14} />
                      <b>{m.name}</b>
                      <Badge>
                        {m.origin === "example" ? "合成原件" : "浏览器本地文件"}
                      </Badge>
                    </summary>
                    <pre>{m.text}</pre>
                  </details>
                ))}
                <label className="material-upload">
                  <Paperclip size={14} />
                  更换文本/JSON 原件
                  <input
                    aria-label="更换任务材料"
                    type="file"
                    accept=".txt,.md,.json,.csv"
                    disabled={!canRespond}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 200000) {
                        notify("本演示最多处理 200 KB 文本材料。", true);
                        return;
                      }
                      const text = await file.text();
                      if (scenario.id === "review") {
                        notify(
                          "用例评审当前使用固定合成样例，不能把新材料自动标为已经评审。请在演示范围内查看修改与复审过程。",
                          true,
                        );
                        return;
                      }
                      act({
                        type: "attachMaterial",
                        id: task.id,
                        material: { name: file.name, text, origin: "local" },
                      });
                      e.target.value = "";
                    }}
                  />
                </label>
                <p className="card-note">
                  文件留在当前浏览器；更换材料产生新修订，使旧意见、批准和制品检查失效。原始
                  .xmind 与一般 Excel 解析尚未接入。
                </p>
              </Card>
            </>
          )}
          {tab === "runs" && (
            <>
              <Card title="同一工作保留每次运行">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>运行</th>
                        <th>输入修订</th>
                        <th>状态</th>
                        <th>触发</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.runs
                        .filter((r) => r.taskId === task.id)
                        .map((r) => (
                          <tr key={r.id}>
                            <td>{r.id}</td>
                            <td>
                              input-r{r.inputRevision}
                              <small>
                                {r.materials?.map((m) => m.name).join("、")}
                              </small>
                            </td>
                            <td>{r.status}</td>
                            <td>{r.trigger}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="事件与人员决定">
                {state.audit
                  .filter((a) => a.task === task.id)
                  .map((a) => (
                    <div className="work-event" key={a.id}>
                      <code>{a.time}</code>
                      <b>{a.actor}</b>
                      <span>{a.detail}</span>
                      <Badge>{a.result}</Badge>
                    </div>
                  ))}
              </Card>
            </>
          )}
          {tab === "delivery" && (
            <Card title="结果与交付范围">
              <ul className="deliverable-list">
                {scenario.deliverables.map((x) => (
                  <li key={x}>
                    <Check size={14} />
                    {x}
                  </li>
                ))}
              </ul>
              <Badge tone={task.phase === "done" ? "green" : "amber"}>
                {task.phase === "done"
                  ? "演示结果已交付"
                  : "尚未交付；当前只是结果预览"}
              </Badge>
              <p className="paragraph">{scenario.boundary}</p>
              {task.unknowns.map((x, i) => (
                <p key={i} className="card-note">
                  {x}
                </p>
              ))}
              <div className="row gap">
                <Button
                  small
                  primary
                  disabled={task.phase !== "done" || busy}
                  onClick={() =>
                    scenario.id === "outline"
                      ? build(true)
                      : downloadJson(
                          `${scenario.id}-input-r${task.inputRevision}.json`,
                          {
                            source: "synthetic-demo",
                            taskId: task.id,
                            inputRevision: task.inputRevision,
                            prompt: task.prompt,
                            materials: work.materials,
                            decisions: work.decisions,
                            columns: scenario.columns,
                            rows: scenario.rows,
                            boundary: scenario.boundary,
                          },
                        )
                  }
                >
                  <Download size={14} />
                  {scenario.id === "outline"
                    ? "下载结构 Excel"
                    : "导出演示结果 JSON"}
                </Button>
              </div>
            </Card>
          )}
        </main>
        <aside className="context-panel">
          <Card title="这项工作的上下文">
            <KeyValues
              items={[
                {
                  label: "发布 Agent",
                  value: state.agents.find((a) => a.id === task.agentId)?.name,
                },
                { label: "版本", value: task.agentVersion },
                { label: "固定资料", value: task.snapshot },
                { label: "输入", value: `input-r${task.inputRevision}` },
                { label: "运行", value: task.runId },
                {
                  label: "执行方式",
                  value:
                    scenario.scene === "none"
                      ? "文档/知识处理，无设备会话"
                      : scenario.scene === "workspace"
                        ? "隔离代码工作区示例"
                        : scenario.scene === "lab"
                          ? "测试环境示例"
                          : "关联同一执行会话",
                },
              ]}
            />
            {["ssh", "web"].includes(scenario.scene) && (
              <Button small onClick={() => openScene(task.id)}>
                <Terminal size={13} />
                查看同一执行现场
              </Button>
            )}
          </Card>
          <Card title="任务输入与进展">
            <Progress value={task.progress} />
            {task.evidence.map((id) => (
              <button
                className="text-link"
                key={id}
                onClick={() => openEvidence(id)}
              >
                <FileText size={13} />
                展开实际输入与结果样例
              </button>
            ))}
            <textarea
              className="work-response"
              aria-label="补充工作输入"
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="补充材料、条件或修改要求"
              disabled={!canRespond}
            />
            <Button
              small
              disabled={!canRespond || !response.trim()}
              onClick={() => {
                const r = act({ type: "revise", id: task.id, text: response });
                if (r.ok) setResponse("");
              }}
            >
              保留新输入修订
            </Button>
          </Card>
        </aside>
      </div>
    </div>
  );
}
