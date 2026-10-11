import { createContext, useContext } from "react";
import type {
  Context,
  DemoAction,
  DemoResult,
  DemoState,
  Page,
  Role,
} from "./domain.ts";
import type { ScenarioId } from "./workflows.ts";
export interface DemoContextValue {
  state: DemoState;
  context: Context;
  page: Page;
  act: (action: DemoAction) => DemoResult;
  go: (page: Page) => void;
  openTask: (id: string) => void;
  openScene: (id: string) => void;
  sceneRequested: boolean;
  openEvidence: (id: string) => void;
  openDocument: (id: string) => void;
  openAgent: (id: string, tab?: string, input?: string) => void;
  agentSelection: { id: string; tab: string; input?: string } | null;
  focusTaskId: string;
  setRole: (role: Role) => void;
  notify: (message: string, error?: boolean) => void;
  startScenario: (id: ScenarioId) => void;
  scenarioSelection: { id: ScenarioId; nonce: number } | null;
}
export const DemoContext = createContext<DemoContextValue | null>(null);
export function useDemo() {
  const value = useContext(DemoContext);
  if (!value) throw Error("Missing demo context");
  return value;
}
