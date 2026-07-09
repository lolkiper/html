export interface ZaliverBridge {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  platform: string;
}

declare global {
  interface Window {
    zaliver?: ZaliverBridge;
  }
}

export function getBridge(): ZaliverBridge | null {
  return typeof window !== "undefined" && window.zaliver ? window.zaliver : null;
}
