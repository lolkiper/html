export type UploadMode = "single" | "multi";

export type NavKey =
  | "dashboard"
  | "autologin"
  | "accounts"
  | "titles"
  | "statistics"
  | "settings";

export type LogLevel = "success" | "error" | "info";

export interface LogEntry {
  id: string;
  time: string;
  level: LogLevel;
  text: string;
}

export type SlotState = "idle" | "running" | "success" | "error";

export interface Slot {
  id: number;
  label: string;
  state: SlotState;
  logs: LogEntry[];
}

export type AccountStatus = "active" | "banned" | "idle" | "checking";

export interface Account {
  id: number;
  browserId: string;
  status: AccountStatus;
}

export type ChannelStatus = "success" | "failed" | "idle";

export interface ChannelStat {
  id: number;
  channelName: string;
  subscribers: number;
  views: number;
  lastUpload: string;
  status: ChannelStatus;
}
