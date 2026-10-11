import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Conversation, Owner, Permission } from "../platform/types";

export interface PluginPageProps {
  conversationId: string;
}
export interface SessionContributionProps {
  conversation: Conversation;
}
export interface PageContribution {
  path: string;
  label: string;
  description: string;
  icon: LucideIcon;
  permission?: Permission;
  component: ComponentType<PluginPageProps>;
}
export interface SessionContribution {
  id: string;
  label: string;
  icon: LucideIcon;
  permission?: Permission;
  component: ComponentType<SessionContributionProps>;
}
/** Trusted, bundled UI modules only. This manifest is not a security sandbox. */
export interface WorkbenchPlugin {
  id: string;
  version: string;
  apiVersion: 1;
  name: string;
  description: string;
  owner?: Owner;
  icon: LucideIcon;
  requires?: string[];
  pages?: PageContribution[];
  panels?: SessionContribution[];
  contextWidgets?: SessionContribution[];
  contextActions?: SessionContribution[];
  recordPage?: string;
}
export type WorkbenchPreset = "circle" | "infosec" | "custom";
export interface PluginPreferences {
  preset: WorkbenchPreset;
  enabledIds: string[];
}
export interface RegisteredContribution<T> {
  plugin: WorkbenchPlugin;
  contribution: T;
}
