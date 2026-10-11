import { ArrowUpRight, CirclePlay } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../../app/context";
import { Badge, Button, EmptyState, Modal } from "../../components/ui";
import type { WorkRun } from "../../platform/types";
import {
  FactList,
  PageFrame,
  RecordsToolbar,
  statusBadge,
  useRecord,
} from "./shared";
export function WorkPage() {
  const { snapshot } = useWorkbench();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const { selectedId, openRecord, closeRecord } = useRecord();
  const works = snapshot.work.filter(
    (w) =>
      (filter === "all" || w.status === filter) &&
      (w.title + w.id).includes(search),
  );
  return (
    <PageFrame
      title="长期工作"
      description="查看后台运行、等待项和交接"
      owner="C"
    >
      <RecordsToolbar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        options={["running", "waiting", "completed"]}
        count={works.length}
      />
      <div className="records-table">
        <table>
          <thead>
            <tr>
              <th>工作</th>
              <th>来源会话</th>
              <th>运行状态</th>
              <th>请求</th>
            </tr>
          </thead>
          <tbody>
            {works.map((work) => (
              <tr key={work.id}>
                <td>
                  <button
                    className="record-title"
                    onClick={() => openRecord(work.id)}
                  >
                    <CirclePlay size={16} />
                    <span>
                      <strong>{work.title}</strong>
                      <small>{work.id}</small>
                    </span>
                  </button>
                </td>
                <td>
                  {snapshot.conversations.find(
                    (c) => c.id === work.conversationId,
                  )?.title ?? "来源会话"}
                </td>
                <td>{statusBadge(work.status)}</td>
                <td>
                  {work.requested === "none" ? (
                    <span className="muted">—</span>
                  ) : (
                    <Badge tone="amber">
                      {work.requested === "pause" ? "已请求暂停" : "已请求取消"}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!works.length && <EmptyState title="没有匹配的工作" />}
      </div>
      <Modal
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) closeRecord();
        }}
        title={
          snapshot.work.find((w) => w.id === selectedId)?.title ?? "长期工作"
        }
        wide
      >
        <WorkDetail work={snapshot.work.find((w) => w.id === selectedId)} />
      </Modal>
    </PageFrame>
  );
}
function WorkDetail({ work }: { work: WorkRun | undefined }) {
  const { gateway, snapshot, perform } = useWorkbench();
  const navigate = useNavigate();
  if (!work) return <EmptyState title="工作不存在" />;
  return (
    <>
      <div className="detail-status">
        {statusBadge(work.status)}
        {work.requested !== "none" && (
          <Badge tone="amber">
            {work.requested === "pause" ? "暂停已请求" : "取消已请求"}
          </Badge>
        )}
        <code>{work.id}</code>
      </div>
      <p className="dialog-paragraph">{work.goal}</p>
      <FactList
        values={{
          来源会话:
            snapshot.conversations.find((c) => c.id === work.conversationId)
              ?.title ?? work.conversationId,
          实际操作: work.operationIds.join(", ") || "暂无",
          工作状态: work.status,
          请求意图: work.requested,
        }}
      />
      <div className="detail-actions">
        <Button onClick={() => navigate(`/agent/${work.conversationId}`)}>
          打开来源会话
          <ArrowUpRight size={13} />
        </Button>
        <Button
          disabled={
            !gateway.can("request-operation") || work.status === "completed"
          }
          onClick={() =>
            perform(
              () => gateway.requestWork(work.id, "pause"),
              "已记录暂停意图，实际执行尚未确认停止。",
            )
          }
        >
          请求暂停
        </Button>
        <Button
          disabled={
            !gateway.can("request-operation") || work.status === "completed"
          }
          onClick={() =>
            perform(
              () => gateway.requestWork(work.id, "cancel"),
              "已记录取消意图，实际执行尚未确认停止。",
            )
          }
        >
          请求取消
        </Button>
      </div>
      <h3 className="detail-section-heading">记录</h3>
      <div className="timeline">
        {work.events.map((event, i) => (
          <div key={`${event.at}-${i}`}>
            <i />
            <span>{event.text}</span>
            <time>{event.at}</time>
          </div>
        ))}
      </div>
      <h3 className="detail-section-heading">完成要求</h3>
      <ul className="check-list">
        {work.checks.map((check) => (
          <li key={check}>
            <span />
            {check}
          </li>
        ))}
      </ul>
      <p className="detail-note">
        会话、工作与实际执行各有状态。当前预览只记录请求，不操作远端进程。
      </p>
    </>
  );
}
