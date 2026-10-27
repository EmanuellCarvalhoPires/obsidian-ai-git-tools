// Settings of the AI Git Tools plugin, saved in data.json as flat keys.

import { DEV_EVENT_TYPES } from "./core/history/events";
import type { DevEventType } from "./core/history/events";

export interface Settings {
  /** Vault folder with one folder per development project. */
  projectsRoot: string;
  /** Subfolder of each project that receives the event notes. */
  eventsFolder: string;
  /** Subfolder of each project that receives the changelog notes. */
  changelogsFolder: string;
  /** Name of the Environment Keys secret for GitHub. Empty means none. */
  secretGithub: string;
  /** Name of the Environment Keys secret for Bitbucket. Empty means none. */
  secretBitbucket: string;
  /** Absolute folders, besides the project clones, that the git tools may use. */
  allowedFolders: string[];
  /** The git tools may use any folder that is a git repository, not only the allowed ones. */
  allowAnyFolder: boolean;
  /** Records the commits made outside the tools (the terminal) by watching the reflogs. */
  watch: boolean;
  /** Reads pull requests and pipelines from the remote on a timer. */
  remotePolling: boolean;
  /** Minutes between two remote reads. */
  remoteIntervalMin: number;
  /** Last project chosen in the module screen. */
  lastProject: string;
  /** Kinds of event that become notes. The default leaves out commit and push, which are the bulk of the notes. */
  eventTypes: DevEventType[];
}

export const DEFAULT_SETTINGS: Settings = {
  projectsRoot: "Projetos",
  eventsFolder: "Eventos",
  changelogsFolder: "Changelogs",
  secretGithub: "",
  secretBitbucket: "",
  allowedFolders: [],
  allowAnyFolder: false,
  watch: true,
  remotePolling: true,
  remoteIntervalMin: 30,
  lastProject: "",
  eventTypes: ["pr", "deploy", "branch"],
};

/** Fills the missing or invalid keys of the saved data with the defaults. */
export function normalizeSettings(raw: unknown): Settings {
  const r: Record<string, unknown> = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  const text = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
  const flag = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  return {
    projectsRoot: text(r.projectsRoot, d.projectsRoot),
    eventsFolder: text(r.eventsFolder, d.eventsFolder),
    changelogsFolder: text(r.changelogsFolder, d.changelogsFolder),
    secretGithub: text(r.secretGithub, d.secretGithub),
    secretBitbucket: text(r.secretBitbucket, d.secretBitbucket),
    allowedFolders: Array.isArray(r.allowedFolders) ? r.allowedFolders.filter((f): f is string => typeof f === "string") : [],
    allowAnyFolder: flag(r.allowAnyFolder, d.allowAnyFolder),
    watch: flag(r.watch, d.watch),
    remotePolling: flag(r.remotePolling, d.remotePolling),
    remoteIntervalMin: typeof r.remoteIntervalMin === "number" && r.remoteIntervalMin > 0 ? r.remoteIntervalMin : d.remoteIntervalMin,
    lastProject: text(r.lastProject, d.lastProject),
    eventTypes: Array.isArray(r.eventTypes) ? DEV_EVENT_TYPES.filter((type) => (r.eventTypes as unknown[]).includes(type)) : [...d.eventTypes],
  };
}
