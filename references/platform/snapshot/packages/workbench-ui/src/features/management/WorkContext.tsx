import { CirclePlay } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../../app/context";
import { Badge } from "../../components/ui";
import type { SessionContributionProps } from "../../plugins/types";
export function WorkContext({ conversation }: SessionContributionProps) {
  const { snapshot } = useWorkbench();
  const navigate = useNavigate();
  const work = snapshot.work.filter(
    (w) => w.conversationId === conversation.id,
  );
  return (
    <section>
      <div className="panel-section-title">
        <h2>关联的长期工作</h2>
        <span>{work.length}</span>
      </div>
      {work.length ? (
        work.map((w) => (
          <button
            className="linked-work"
            key={w.id}
            onClick={() => navigate(`/manage/work?record=${w.id}`)}
          >
            <CirclePlay size={16} />
            <span>
              <strong>{w.title}</strong>
              <small>{w.id}</small>
            </span>
            <Badge tone={w.status === "running" ? "blue" : "neutral"}>
              {w.status === "running"
                ? "运行中"
                : w.status === "waiting"
                  ? "等待中"
                  : "已完成"}
            </Badge>
          </button>
        ))
      ) : (
        <p className="panel-muted">此会话尚未关联长期工作。</p>
      )}
    </section>
  );
}
