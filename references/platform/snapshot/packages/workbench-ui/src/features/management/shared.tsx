import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "../../components/ui";
import type { Role } from "../../platform/types";
export const roleLabels: Record<Role, string> = {
  engineer: "工程师",
  viewer: "观察员",
  expert: "方法维护者",
  maintainer: "平台运维",
};
export function statusBadge(value: string) {
  const values: Record<
    string,
    [string, "green" | "amber" | "blue" | "neutral"]
  > = {
    running: ["运行中", "blue"],
    waiting: ["等待中", "amber"],
    completed: ["已完成", "green"],
    ready: ["就绪", "green"],
    unknown: ["待核对", "amber"],
    published: ["已发布", "green"],
    candidate: ["候选", "amber"],
  };
  const [label, tone] = values[value] ?? [value, "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}
export function FactList({ values }: { values: Record<string, string> }) {
  return (
    <dl className="fact-list">
      {Object.entries(values).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function useRecord() {
  const [params, setParams] = useSearchParams();
  return {
    selectedId: params.get("record"),
    openRecord: (id: string) => setParams({ record: id }),
    closeRecord: () => setParams({}),
  };
}
export function PageFrame({
  title,
  description,
  owner,
  action,
  children,
}: {
  title: string;
  description: string;
  owner?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="management-page">
      <div className="management-heading">
        <div>
          <div className="owner-label">
            {owner ? owner + " / 平台管理" : "工作台"}
          </div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function RecordsToolbar({
  search,
  onSearch,
  filter,
  onFilter,
  options,
  count,
  extra,
}: {
  search: string;
  onSearch: (value: string) => void;
  filter: string;
  onFilter: (value: string) => void;
  options: string[];
  count: number;
  extra?: ReactNode;
}) {
  return (
    <div className="table-toolbar">
      <div className="search-input">
        <Search size={15} />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="搜索名称或编号"
          aria-label="搜索管理记录"
        />
      </div>
      <select
        className="select"
        aria-label="筛选管理记录"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
      >
        <option value="all">全部</option>
        {options.map((item) => (
          <option key={item} value={item}>
            {(
              {
                running: "运行中",
                waiting: "等待中",
                completed: "已完成",
              } as Record<string, string>
            )[item] ?? item}
          </option>
        ))}
      </select>
      {extra}
      <span className="result-count">{count} 项</span>
    </div>
  );
}
