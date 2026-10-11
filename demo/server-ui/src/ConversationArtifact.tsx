import { useState } from "react";
import { Check, Download, FileText, X } from "lucide-react";
import { useDemo } from "./ui-context.tsx";
import { Badge, Button, Notice, Tabs } from "./components.tsx";
import { permitted, type Task } from "./domain.ts";
import { outlineRows, pendingFindings, workflowFor } from "./workflows.ts";
import {
  base64ToBytes,
  buildOutlineWorkbook,
  bytesToBase64,
  downloadBytes,
  downloadJson,
  rowValues,
} from "./workflow-files.ts";
export default function ConversationArtifact({
  task,
  onClose,
  continueWork,
}: {
  task: Task;
  onClose: () => void;
  continueWork: (id: string) => void;
}) {
  const { context, act, notify } = useDemo();
  const scenario = workflowFor(task)!;
  const work = task.workflowState!;
  const [tab, setTab] = useState("result");
  const [busy, setBusy] = useState(false);
  const canEdit = permitted(context, "task.respond");
  let outline: ReturnType<typeof outlineRows> | undefined;
  let error = "";
  if (scenario.id === "outline")
    try {
      outline = outlineRows(work.materials[0]?.text ?? "");
    } catch (e) {
      error = String(e);
    }
  const generate = async () => {
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
      if (saved.ok) continueWork(task.id);
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const report = () => {
    const text =
      "# 测试用例评审\n\n任务：" +
      task.id +
      "；输入修订：" +
      task.inputRevision +
      "\n\n" +
      work.decisions
        .map(
          (d) =>
            "- " +
            d.findingId +
            "：" +
            (d.choice === "accept" ? "采用建议" : "本轮保留原文") +
            "；input-r" +
            d.revision +
            "；" +
            d.reason,
        )
        .join("\n") +
      "\n\n本报告使用固定合成样例，没有运行真实模型评审。缺少的产品通过阈值仍待确认。\n";
    downloadBytes(
      "用例评审报告.md",
      new TextEncoder().encode(text),
      "text/markdown;charset=utf-8",
    );
  };
  const decide = (id: string, choice: "accept" | "dismiss") =>
    act({
      type: "findingDecision",
      id: task.id,
      findingId: id,
      choice,
      reason:
        choice === "accept"
          ? "用户选择按这条建议修订"
          : "用户本轮保留原文，未采用这条建议",
    });
  return (
    <aside className="conversation-artifact" aria-label="会话工作结果">
      <header>
        <div>
          <small>与这段会话一起保留</small>
          <h3>
            {scenario.id === "review"
              ? "用例评审"
              : scenario.id === "outline"
                ? "Excel 预览"
                : scenario.title}
          </h3>
        </div>
        <button onClick={onClose} aria-label="关闭工作结果">
          <X size={17} />
        </button>
      </header>
      <Tabs
        tabs={[
          { id: "result", label: "结果" },
          { id: "source", label: "材料与依据" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="artifact-body">
        {tab === "source" ? (
          <>
            {work.materials.map((m, i) => (
              <details className="material-detail" key={i} open={i === 0}>
                <summary>
                  <FileText size={14} />
                  <b>{m.name}</b>
                  <Badge>
                    {m.origin === "example" ? "演示材料" : "本地文件"}
                  </Badge>
                </summary>
                <pre>{m.text}</pre>
              </details>
            ))}
            <p className="artifact-note">
              原件、输入修订和处理记录一起保留。文件只在当前浏览器中处理。
            </p>
          </>
        ) : scenario.id === "review" ? (
          <>
            {pendingFindings(task).map((f) => {
              const d = work.decisions.find(
                (d) =>
                  d.findingId === f.id && d.revision === task.inputRevision,
              );
              return (
                <article className="conversation-finding" key={f.id}>
                  <div className="row gap">
                    <b>{f.location}</b>
                    {d && (
                      <Badge tone="green">
                        {d.choice === "accept" ? "采用" : "保留原文"}
                      </Badge>
                    )}
                  </div>
                  <blockquote>{f.original}</blockquote>
                  <p>{f.explanation}</p>
                  <details>
                    <summary>查看依据和建议</summary>
                    <small>{f.source}</small>
                    <div className="finding-proposal">{f.proposed}</div>
                  </details>
                  <div className="row gap">
                    <Button
                      small
                      disabled={!canEdit}
                      onClick={() => decide(f.id, "accept")}
                    >
                      采用这条建议
                    </Button>
                    <Button
                      small
                      disabled={!canEdit}
                      onClick={() => decide(f.id, "dismiss")}
                    >
                      暂不采用
                    </Button>
                  </div>
                </article>
              );
            })}
            {work.appliedRevision ? (
              <div className="artifact-complete">
                <Check size={19} />
                <div>
                  <b>修改和上一版一起保留了</b>
                  <p>
                    已形成新用例修订。接受项已调整，缺少的产品判据继续保留为待确认。
                  </p>
                </div>
              </div>
            ) : (
              <Button
                primary
                disabled={!canEdit || work.decisions.length !== 2}
                onClick={() => {
                  if (work.decisions.some((d) => d.choice === "accept")) {
                    const r = act({ type: "applyReviewEdits", id: task.id });
                    if (!r.ok) return;
                  }
                  continueWork(task.id);
                }}
              >
                按本轮意见生成结果
              </Button>
            )}
            {task.phase === "done" && (
              <Button small onClick={report}>
                <Download size={14} />
                下载评审报告
              </Button>
            )}
            <p className="artifact-note">
              这里展示固定合成评审意见，未对新文件运行模型评审。
            </p>
          </>
        ) : scenario.id === "outline" ? (
          <>
            {!work.outputChoice && !/七列|结构|清单/.test(task.prompt) && (
              <div className="output-question">
                <b>你想得到哪种结果？</b>
                <p>结构清单保留原节点；业务用例还需要补齐操作和预期依据。</p>
                <div className="row gap">
                  <Button
                    small
                    onClick={() => {
                      const r = act({
                        type: "chooseOutput",
                        id: task.id,
                        mode: "outline",
                      });
                      if (r.ok) continueWork(task.id);
                    }}
                  >
                    先整理成 Excel 清单
                  </Button>
                  <Button
                    small
                    onClick={() => {
                      const r = act({
                        type: "chooseOutput",
                        id: task.id,
                        mode: "compile",
                      });
                      if (r.ok) continueWork(task.id);
                    }}
                  >
                    组织测试步骤方案
                  </Button>
                </div>
              </div>
            )}
            {error ? (
              <Notice tone="amber">{error}</Notice>
            ) : (
              <>
                <p className="artifact-subtitle">
                  用例清单 · {outline?.rows.length} 行
                </p>
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
              </>
            )}
            {!!outline?.unmapped.length && (
              <Notice tone="amber">
                这些元素未映射：{outline.unmapped.join("；")}。会随说明表保留。
              </Notice>
            )}
            {work.artifactReceipt?.checked ? (
              <>
                <div className="artifact-complete">
                  <Check size={18} />
                  <div>
                    <b>工作簿已生成并读回检查</b>
                    <p>两张工作表、七列映射和单元格类型已核对。</p>
                  </div>
                </div>
                <Button
                  primary
                  onClick={() =>
                    work.workbookBase64 &&
                    downloadBytes(
                      "脑图结构清单.xlsx",
                      base64ToBytes(work.workbookBase64),
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    )
                  }
                >
                  <Download size={14} />
                  下载 Excel
                </Button>
              </>
            ) : (
              <Button
                primary
                disabled={
                  !canEdit ||
                  busy ||
                  !!error ||
                  (!work.outputChoice && !/七列|结构|清单/.test(task.prompt))
                }
                onClick={generate}
              >
                {busy ? "正在生成…" : "生成 Excel"}
              </Button>
            )}
            <p className="artifact-note">
              这是结构清单，不补造测试命令。演示支持主题树 JSON 和 XMind
              content.json；完整 .xmind 包尚未接入。
            </p>
          </>
        ) : (
          <>
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
            {scenario.scene === "workspace" && (
              <pre className="code-diff">
                {
                  '// 合成修改差异\n- const timeout = Number(args.timeout ?? 3000);\n+ const timeout = parsePositiveTimeout(args.timeout ?? 3000);\n+ if (timeout <= 0) throw new Error("invalid timeout");'
                }
              </pre>
            )}
            <p className="artifact-note">{scenario.boundary}</p>
            {task.phase === "done" && (
              <Button
                small
                onClick={() =>
                  downloadJson(scenario.id + "-result.json", {
                    source: "synthetic-demo",
                    taskId: task.id,
                    inputRevision: task.inputRevision,
                    columns: scenario.columns,
                    rows: scenario.rows,
                    boundary: scenario.boundary,
                  })
                }
              >
                <Download size={14} />
                保存结果
              </Button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
