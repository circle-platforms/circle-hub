import { Cpu, Folder, Globe, Network, Terminal } from "lucide-react";
import { useState } from "react";
import { useWorkbench } from "../../app/context";
import {
  Badge,
  Button,
  DataBlock,
  EmptyState,
  Modal,
} from "../../components/ui";
import type { ExecutionResource } from "../../platform/types";
import {
  FactList,
  PageFrame,
  RecordsToolbar,
  statusBadge,
  useRecord,
} from "./shared";
export function ExecutionPage() {
  const { snapshot } = useWorkbench();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const { selectedId, openRecord, closeRecord } = useRecord();
  const [resourceView, setResourceView] = useState<"list" | "map">("list");
  const resources = snapshot.resources.filter(
    (r) =>
      (filter === "all" || r.kind === filter) &&
      (r.name + r.sessionId).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <PageFrame
      title="执行与资源"
      description="工作区、执行节点、设备和浏览器"
      owner="D"
    >
      <RecordsToolbar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        options={["工作区", "执行节点", "SSH", "浏览器"]}
        count={resources.length}
        extra={
          <div className="view-switch">
            <button
              className={resourceView === "list" ? "active" : ""}
              onClick={() => setResourceView("list")}
            >
              列表
            </button>
            <button
              className={resourceView === "map" ? "active" : ""}
              onClick={() => setResourceView("map")}
            >
              资源关系
            </button>
          </div>
        }
      />
      {resourceView === "map" ? (
        <div className="resource-map">
          <div className="resource-map-heading">
            <Network size={15} />
            资源关联<span>前端样例</span>
          </div>
          <div className="resource-map-canvas">
            {resources.map((resource, index) => (
              <div className="resource-map-step" key={resource.id}>
                {index > 0 && <span className="map-connection" />}
                <button
                  className="resource-node"
                  onClick={() => openRecord(resource.id)}
                >
                  {resource.kind === "工作区" ? (
                    <Folder size={21} />
                  ) : resource.kind === "浏览器" ? (
                    <Globe size={21} />
                  ) : resource.kind === "SSH" ? (
                    <Terminal size={21} />
                  ) : (
                    <Cpu size={21} />
                  )}
                  <strong>{resource.name}</strong>
                  <small>
                    {resource.kind} · {resource.location}
                  </small>
                  {statusBadge(resource.status)}
                </button>
              </div>
            ))}
          </div>
          <p className="map-note">
            这里展示工作区与执行资源的关联，不表示已经验证实际网络拓扑。
          </p>
        </div>
      ) : (
        <div className="records-table">
          <table>
            <thead>
              <tr>
                <th>资源</th>
                <th>类型 / 位置</th>
                <th>会话</th>
                <th>控制者</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => (
                <tr key={resource.id}>
                  <td>
                    <button
                      className="record-title"
                      onClick={() => openRecord(resource.id)}
                    >
                      {resource.kind === "浏览器" ? (
                        <Globe size={16} />
                      ) : resource.kind === "SSH" ? (
                        <Terminal size={16} />
                      ) : (
                        <Folder size={16} />
                      )}
                      <span>
                        <strong>{resource.name}</strong>
                        <small>{resource.id}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    {resource.kind} · {resource.location}
                  </td>
                  <td>
                    <code>{resource.sessionId}</code>
                  </td>
                  <td>{resource.controller}</td>
                  <td>{statusBadge(resource.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!resources.length && <EmptyState title="没有匹配的资源" />}
        </div>
      )}
      <Modal
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) closeRecord();
        }}
        title={
          snapshot.resources.find((r) => r.id === selectedId)?.name ??
          "执行资源"
        }
        wide
      >
        <ResourceDetail
          resource={snapshot.resources.find((r) => r.id === selectedId)}
        />
      </Modal>
    </PageFrame>
  );
}
function ResourceDetail({
  resource,
}: {
  resource: ExecutionResource | undefined;
}) {
  const { gateway, perform, notify } = useWorkbench();
  if (!resource) return <EmptyState title="资源不存在" />;
  return (
    <>
      <div className="detail-status">
        {statusBadge(resource.status)}
        <Badge>{resource.kind}</Badge>
        <code>{resource.sessionId}</code>
      </div>
      <FactList
        values={{
          位置: resource.location,
          当前控制: resource.controller,
          关联操作: resource.operationId ?? "暂无",
          ...resource.facts,
        }}
      />
      <div className="detail-actions">
        <Button
          disabled={!gateway.can("request-operation")}
          onClick={() =>
            perform(
              () => gateway.requestResourceControl(resource.id),
              "请求已保存到本地预览，执行端尚未连接。",
            )
          }
        >
          请求控制
        </Button>
        <Button
          onClick={() =>
            notify(
              `样例记录显示：${resource.status === "running" ? "仍在运行" : resource.status === "unknown" ? "状态待核对" : "资源就绪"}。没有进行真实探测。`,
            )
          }
        >
          核对状态
        </Button>
      </div>
      <DataBlock
        title="观察记录"
        value={{
          resourceId: resource.id,
          sessionId: resource.sessionId,
          status: resource.status,
          operationId: resource.operationId,
          source: "frontend-fixture",
          observedRealEffect: false,
        }}
      />
    </>
  );
}
