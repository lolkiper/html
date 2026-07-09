import type { Account, ChannelStat, LogEntry, Slot } from "../types";

let logIdCounter = 0;

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function makeLog(level: LogEntry["level"], text: string): LogEntry {
  logIdCounter += 1;
  return { id: `log-${logIdCounter}-${Date.now()}`, time: nowStamp(), level, text };
}

export const UPLOAD_STEPS: Array<{ level: LogEntry["level"]; text: string }> = [
  { level: "info", text: "Thread Started" },
  { level: "info", text: "Browser Opened" },
  { level: "info", text: "Connected" },
  { level: "info", text: "Uploading Video" },
  { level: "info", text: "Filling Title" },
  { level: "info", text: "Filling Description" },
  { level: "info", text: "Uploading Thumbnail" },
  { level: "info", text: "Publishing" },
  { level: "success", text: "Upload Successful" },
];

export const ERROR_STEPS: Array<{ level: LogEntry["level"]; text: string }> = [
  { level: "info", text: "Thread Started" },
  { level: "info", text: "Browser Opened" },
  { level: "error", text: "Connection Timeout" },
  { level: "error", text: "Upload Failed" },
];

export function createInitialSlots(count: number): Slot[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    label: `Slot ${i + 1}`,
    state: "idle",
    logs:
      i === 0
        ? UPLOAD_STEPS.map((s) => makeLog(s.level, s.text))
        : [],
  }));
}

export const MOCK_ACCOUNTS: Account[] = [
  { id: 1, browserId: "819465082", status: "active" },
  { id: 2, browserId: "819465091", status: "active" },
  { id: 3, browserId: "819465104", status: "banned" },
  { id: 4, browserId: "819465117", status: "active" },
  { id: 5, browserId: "819465129", status: "idle" },
  { id: 6, browserId: "819465138", status: "checking" },
];

export const MOCK_TITLES = [
  "I Tried This For 24 Hours...",
  "You Won't Believe What Happened Next",
  "This Changed Everything (Shorts Edition)",
  "POV: You Discover The Secret",
  "Wait For It...",
  "Nobody Talks About This Trick",
  "The Truth About Viral Shorts",
  "Watch Until The End!",
  "This Is Why It Works Every Time",
  "3 Seconds That Broke The Internet",
];

export const MOCK_CHANNELS: ChannelStat[] = [
  { id: 1, channelName: "Channel Nova", subscribers: 128_400, views: 4_820_000, lastUpload: "2m ago", status: "success" },
  { id: 2, channelName: "Channel Pulse", subscribers: 84_210, views: 2_140_000, lastUpload: "6m ago", status: "success" },
  { id: 3, channelName: "Channel Ember", subscribers: 51_902, views: 1_005_300, lastUpload: "14m ago", status: "failed" },
  { id: 4, channelName: "Channel Drift", subscribers: 203_005, views: 9_442_100, lastUpload: "1m ago", status: "success" },
  { id: 5, channelName: "Channel Nyx", subscribers: 12_887, views: 320_140, lastUpload: "—", status: "idle" },
  { id: 6, channelName: "Channel Vortex", subscribers: 67_400, views: 1_820_990, lastUpload: "22m ago", status: "success" },
];

export const ACCOUNTS_TXT_PLACEHOLDER = `email1@gmail.com|Password123|JBSWY3DPEHPK3PXP|proxy.host:8080:user:pass:http
email2@gmail.com|Password456|KRSXG5CTMVRXEZLU|proxy.host:8081:user:pass:http
email3@gmail.com|Password789|MFRGGZDFMZTWQ2LK|proxy.host:8082:user:pass:http`;
