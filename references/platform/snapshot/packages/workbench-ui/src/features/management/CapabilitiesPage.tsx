import { Blocks } from "lucide-react";
import { useState } from "react";
import { useWorkbench } from "../../app/context";
import {
  Badge,
  Button,
  DataBlock,
  EmptyState,
  Modal,
} from "../../components/ui";
import type { Capability } from "../../platform/types";
import type { PluginPageProps } from "../../plugins/types";
import {
  FactList,
  PageFrame,
  RecordsToolbar,
  statusBadge,
  useRecord,
} from "./shared";
export function CapabilitiesPage({ conversationId }: PluginPageProps) {
  const { snapshot, gateway, perform } = useWorkbench();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const { selectedId, openRecord, closeRecord } = useRecord();
  const capabilities = snapshot.capabilities.filter(
    (c) =>
      (filter === "all" || c.kind === filter) &&
      (c.name + c.description).includes(search),
  );
  const conversation =
    snapshot.conversations.find((c) => c.id === conversationId) ??
    snapshot.conversations[0];
  return (
    <PageFrame
      title="能力与方法"
      description="查看适用范围、版本与会话加载"
      owner="E"
    >
      <RecordsToolbar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        options={["Skill", "工具包", "规则"]}
        count={capabilities.length}
      />
      <>
        <div className="inline-context">
          <MessageContext title={conversation?.title ?? "当前会话"} />
          <span>勾选后加载到这个会话，方法版本本身不变。</span>
        </div>
        <div className="records-table">
          <table>
            <thead>
              <tr>
                <th>能力</th>
                <th>类型</th>
                <th>版本</th>
                <th>发布状态</th>
                <th>当前会话</th>
              </tr>
            </thead>
            <tbody>
              {capabilities.map((capability) => (
                <tr key={capability.id}>
                  <td>
                    <button
                      className="record-title"
                      onClick={() => openRecord(capability.id)}
                    >
                      <Blocks size={16} />
                      <span>
                        <strong>{capability.name}</strong>
                        <small>{capability.description}</small>
                      </span>
                    </button>
                  </td>
                  <td>{capability.kind}</td>
                  <td>
                    <code>{capability.version}</code>
                  </td>
                  <td>{statusBadge(capability.status)}</td>
                  <td>
                    <label className="switch">
                      <input
                        type="checkbox"
                        aria-label={`加载 ${capability.name}`}
                        checked={
                          conversation?.capabilityIds.includes(capability.id) ??
                          false
                        }
                        disabled={
                          !gateway.can("conversation") ||
                          capability.status !== "published"
                        }
                        onChange={(e) =>
                          perform(() =>
                            gateway.setCapability(
                              conversation.id,
                              capability.id,
                              e.target.checked,
                            ),
                          )
                        }
                      />
                      <span />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!capabilities.length && <EmptyState title="没有匹配的能力" />}
        </div>
      </>
      <Modal
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) closeRecord();
        }}
        title={
          snapshot.capabilities.find((c) => c.id === selectedId)?.name ?? "能力"
        }
        wide
      >
        <CapabilityDetail
          capability={snapshot.capabilities.find((c) => c.id === selectedId)}
        />
      </Modal>
    </PageFrame>
  );
}
function CapabilityDetail({
  capability,
}: {
  capability: Capability | undefined;
}) {
  const { gateway, perform } = useWorkbench();
  if (!capability) return <EmptyState title="能力不存在" />;
  return (
    <>
      <div className="detail-status">
        {statusBadge(capability.status)}
        <Badge>{capability.kind}</Badge>
        <code>{capability.version}</code>
      </div>
      <p className="dialog-paragraph">{capability.description}</p>
      <FactList
        values={{
          适用范围: capability.support,
          验证记录: capability.validation,
          版本: capability.version,
        }}
      />
      <DataBlock title="方法说明" value={capability.instructions} />
      {capability.status === "candidate" && (
        <div className="detail-actions">
          <Button
            disabled={!gateway.can("publish-method")}
            onClick={() =>
              perform(
                () => gateway.submitCapabilityReview(capability.id),
                "已提交候选评审，发布状态没有改变。",
              )
            }
          >
            提交版本评审
          </Button>
        </div>
      )}
      <p className="detail-note">
        加载到会话与发布方法是两种操作。已有会话继续引用它加载时的版本。
      </p>
    </>
  );
}
function MessageContext({ title }: { title: string }) {
  return (
    <strong>
      <Blocks size={13} />
      {title}
    </strong>
  );
}
