import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Slot } from "../types";
import { ERROR_STEPS, UPLOAD_STEPS, makeLog } from "../data/mockData";
import { useTheme } from "./ThemeContext";
import { MOCK_ACCOUNTS, MOCK_CHANNELS } from "../data/mockData";

const TOTAL_SLOTS = 10;
const STEP_INTERVAL_MS = 1400;
const MAX_LOG_LINES = 200;

interface SlotRuntime extends Slot {
  stepIndex: number;
  usingErrorPath: boolean;
}

function freshSlots(): SlotRuntime[] {
  return Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    id: i + 1,
    label: `Slot ${i + 1}`,
    state: "idle" as const,
    logs: [],
    stepIndex: 0,
    usingErrorPath: false,
  }));
}

interface FarmContextValue {
  slots: SlotRuntime[];
  activeSlotId: number;
  setActiveSlotId: (id: number) => void;
  isRunning: boolean;
  isPaused: boolean;
  autoScroll: boolean;
  setAutoScroll: (v: boolean) => void;
  togglePause: () => void;
  clearActiveSlotLogs: () => void;
  start: () => void;
  stop: () => void;
  stats: {
    videos: number;
    accounts: number;
    channels: number;
    successfulUploads: number;
    failedUploads: number;
    uploading: number;
  };
}

const FarmContext = createContext<FarmContextValue | null>(null);

export function FarmProvider({ children }: { children: ReactNode }) {
  const { isMulti } = useTheme();
  const [slots, setSlots] = useState<SlotRuntime[]>(freshSlots());
  const [activeSlotId, setActiveSlotId] = useState(1);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [successCount, setSuccessCount] = useState(0);
  const [failCount, setFailCount] = useState(0);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMultiRef = useRef(isMulti);
  isMultiRef.current = isMulti;

  const tick = useCallback(() => {
    setSlots((prev) => {
      const activeCount = isMultiRef.current ? TOTAL_SLOTS : 1;
      return prev.map((slot) => {
        const isActiveSlot = slot.id <= activeCount;
        if (!isActiveSlot) {
          if (slot.state !== "idle") {
            return { ...slot, state: "idle", stepIndex: 0 };
          }
          return slot;
        }

        const path = slot.usingErrorPath ? ERROR_STEPS : UPLOAD_STEPS;
        const nextIndex = slot.stepIndex + 1;

        if (slot.stepIndex === 0 && slot.logs.length === 0) {
          const first = makeLog(path[0].level, path[0].text);
          return { ...slot, state: "running", logs: [first], stepIndex: 1 };
        }

        if (nextIndex > path.length) {
          const willError = Math.random() < 0.12;
          return {
            ...slot,
            stepIndex: 0,
            state: "running",
            usingErrorPath: willError,
            logs: [],
          };
        }

        const step = path[nextIndex - 1];
        const entry = makeLog(step.level, step.text);
        const isFinal = nextIndex === path.length;

        if (isFinal) {
          if (step.level === "success") setSuccessCount((c) => c + 1);
          if (step.level === "error") setFailCount((c) => c + 1);
        }

        const nextLogs = [...slot.logs, entry].slice(-MAX_LOG_LINES);
        return {
          ...slot,
          logs: nextLogs,
          stepIndex: nextIndex,
          state: isFinal ? (step.level === "error" ? "error" : "success") : "running",
        };
      });
    });
  }, []);

  useEffect(() => {
    if (isRunning && !isPaused) {
      intervalRef.current = setInterval(tick, STEP_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, isPaused, tick]);

  const start = useCallback(() => {
    setSlots(freshSlots());
    setSuccessCount(0);
    setFailCount(0);
    setIsPaused(false);
    setIsRunning(true);
    setActiveSlotId(1);
  }, []);

  const stop = useCallback(() => {
    setIsRunning(false);
    setIsPaused(false);
    setSlots((prev) => prev.map((s) => ({ ...s, state: "idle" as const })));
  }, []);

  const togglePause = useCallback(() => setIsPaused((p) => !p), []);

  const clearActiveSlotLogs = useCallback(() => {
    setSlots((prev) =>
      prev.map((s) => (s.id === activeSlotId ? { ...s, logs: [] } : s)),
    );
  }, [activeSlotId]);

  const uploadingCount = useMemo(
    () => (isRunning ? slots.filter((s) => s.id <= (isMulti ? TOTAL_SLOTS : 1)).length : 0),
    [slots, isRunning, isMulti],
  );

  const value: FarmContextValue = {
    slots,
    activeSlotId,
    setActiveSlotId,
    isRunning,
    isPaused,
    autoScroll,
    setAutoScroll,
    togglePause,
    clearActiveSlotLogs,
    start,
    stop,
    stats: {
      videos: successCount + failCount,
      accounts: MOCK_ACCOUNTS.length,
      channels: MOCK_CHANNELS.length,
      successfulUploads: successCount,
      failedUploads: failCount,
      uploading: uploadingCount,
    },
  };

  return <FarmContext.Provider value={value}>{children}</FarmContext.Provider>;
}

export function useFarm() {
  const ctx = useContext(FarmContext);
  if (!ctx) throw new Error("useFarm must be used within FarmProvider");
  return ctx;
}
