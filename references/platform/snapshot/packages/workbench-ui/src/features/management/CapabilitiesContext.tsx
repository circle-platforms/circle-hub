import { ArrowUpRight, Blocks, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../../app/context";
import type { SessionContributionProps } from "../../plugins/types";
export function CapabilitiesContext({
  conversation,
}: SessionContributionProps) {
  const { snapshot } = useWorkbench();
  const navigate = useNavigate();
  return (
    <section>
      <div className="panel-section-title">
        <h2>本会话的能力</h2>
        <button onClick={() => navigate("/manage/capabilities")}>
          管理
          <ArrowUpRight size={11} />
        </button>
      </div>
      {snapshot.capabilities
        .filter((c) => conversation.capabilityIds.includes(c.id))
        .map((cap) => (
          <button
            className="capability-link"
            key={cap.id}
            onClick={() => navigate(`/manage/capabilities?record=${cap.id}`)}
          >
            <Blocks size={14} />
            <span>
              {cap.name}
              <small>{cap.version}</small>
            </span>
            <ChevronRight size={12} />
          </button>
        ))}
    </section>
  );
}
