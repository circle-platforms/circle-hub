import { FileText, Plus, Upload } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWorkbench } from "../../app/context";
import {
  Badge,
  Button,
  DataBlock,
  EmptyState,
  Modal,
} from "../../components/ui";
import type { KnowledgeSource } from "../../platform/types";
import type { PluginPageProps } from "../../plugins/types";
import { FactList, PageFrame, RecordsToolbar, useRecord } from "./shared";
export function KnowledgePage({ conversationId }: PluginPageProps) {
  const { snapshot, gateway, platform, notify } = useWorkbench();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const { selectedId, openRecord, closeRecord } = useRecord();
  const sources = snapshot.sources.filter(
    (s) =>
      (filter === "all" || s.kind === filter) &&
      (s.title + s.description).includes(search),
  );
  const importFiles = async () => {
    try {
      for (const file of await platform.pickFiles()) gateway.importSource(file);
      notify("资料已加入本地预览。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入没有完成。");
    }
  };
  return (
    <PageFrame
      title="知识与记录"
      description="资料、来源、证据和产物"
      owner="B"
      action={
        <Button disabled={!gateway.can("conversation")} onClick={importFiles}>
          <Upload size={14} />
          导入资料
        </Button>
      }
    >
      <RecordsToolbar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        options={["资料", "证据", "产物"]}
        count={sources.length}
      />
      <div className="records-table">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>当前修订</th>
              <th>更新</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td>
                  <button
                    className="record-title"
                    onClick={() => openRecord(source.id)}
                  >
                    <FileText size={16} />
                    <span>
                      <strong>{source.title}</strong>
                      <small>{source.description}</small>
                    </span>
                  </button>
                </td>
                <td>{source.kind}</td>
                <td>
                  <code>rev.{source.revision}</code>
                </td>
                <td>{source.updatedAt}</td>
                <td>
                  <Badge tone={source.published ? "green" : "neutral"}>
                    {source.published ? "已发布" : "记录"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sources.length && <EmptyState title="没有匹配的资料" />}
      </div>
      <Modal
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) closeRecord();
        }}
        title={
          snapshot.sources.find((s) => s.id === selectedId)?.title ?? "资料"
        }
        wide
      >
        <SourceDetail
          source={snapshot.sources.find((s) => s.id === selectedId)}
          conversationId={conversationId}
        />
      </Modal>
    </PageFrame>
  );
}
function SourceDetail({
  source,
  conversationId,
}: {
  source: KnowledgeSource | undefined;
  conversationId: string;
}) {
  const [params, setParams] = useSearchParams();
  const { gateway, perform } = useWorkbench();
  if (!source) return <EmptyState title="资料不存在" />;
  const revision = params.get("revision") ?? source.revision;
  const version = source.versions.find((v) => v.revision === revision);
  return (
    <>
      <div className="detail-toolbar">
        <Badge>{source.kind}</Badge>
        <label>
          查看修订
          <select
            className="select"
            aria-label="资料修订"
            value={revision}
            onChange={(e) =>
              setParams({ record: source.id, revision: e.target.value })
            }
          >
            {source.versions.map((v) => (
              <option key={v.revision} value={v.revision}>
                rev.{v.revision} · {v.date}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!gateway.can("conversation") || !version}
          onClick={() =>
            perform(
              () =>
                gateway.attachContext(conversationId, {
                  id: `${source.id}@${revision}`,
                  name: source.title,
                  kind: "source",
                  revision,
                }),
              "已将这个修订加入会话。",
            )
          }
        >
          <Plus size={13} />
          加入会话
        </Button>
      </div>
      <DataBlock
        title="原文"
        value={version?.content ?? "没有找到这个修订。"}
      />
      <FactList
        values={{
          记录编号: source.id,
          当前发布修订: `rev.${source.revision}`,
          正在查看: `rev.${revision}`,
        }}
      />
      <p className="detail-note">
        这里只切换查看版本。会话和长期工作已有的引用不会自动变化。
      </p>
    </>
  );
}
