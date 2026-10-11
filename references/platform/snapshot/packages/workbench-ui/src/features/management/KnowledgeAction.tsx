import { FileText, Link2, Plus } from "lucide-react";
import { useState } from "react";
import { useWorkbench } from "../../app/context";
import { Modal } from "../../components/ui";
import type { SessionContributionProps } from "../../plugins/types";
export function KnowledgeAction({ conversation }: SessionContributionProps) {
  const { snapshot, gateway, perform } = useWorkbench();
  const [contextOpen, setContextOpen] = useState(false);
  return (
    <>
      <button
        className="text-control"
        onClick={() => setContextOpen(true)}
        disabled={!gateway.can("conversation")}
      >
        <Link2 size={13} />
        引用资料
      </button>
      <Modal
        open={contextOpen}
        onOpenChange={setContextOpen}
        title="引用资料"
        description="按当前版本加入会话。随后浏览其他修订不会改变这里的引用。"
      >
        <div className="selection-list">
          {snapshot.sources.map((source) => (
            <button
              key={source.id}
              onClick={() =>
                perform(() => {
                  gateway.attachContext(conversation.id, {
                    id: `${source.id}@${source.revision}`,
                    name: source.title,
                    kind: "source",
                    revision: source.revision,
                  });
                  setContextOpen(false);
                }, "已加入当前会话。")
              }
            >
              <FileText size={17} />
              <span>
                <strong>{source.title}</strong>
                <small>
                  {source.kind} · rev.{source.revision}
                </small>
              </span>
              <Plus size={14} />
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}
