import { useEffect, useRef } from "react";
import {
  Video,
  Users,
  Tv,
  CheckCircle2,
  XCircle,
  Loader2,
  Pause,
  Play,
  Trash2,
  ArrowDownToLine,
} from "lucide-react";
import clsx from "clsx";
import { StatCard } from "../components/ui/StatCard";
import { GlassCard } from "../components/ui/GlassCard";
import { useFarm } from "../context/FarmContext";
import { useTheme } from "../context/ThemeContext";
import type { LogLevel } from "../types";

const LEVEL_COLOR: Record<LogLevel, string> = {
  success: "#34d399",
  error: "#fb7185",
  info: "#9aa3b4",
};

export function Dashboard() {
  const { accentSolid, accentGlow } = useTheme();
  const {
    slots,
    activeSlotId,
    setActiveSlotId,
    isRunning,
    isPaused,
    autoScroll,
    setAutoScroll,
    togglePause,
    clearActiveSlotLogs,
    stats,
  } = useFarm();

  const activeSlot = slots.find((s) => s.id === activeSlotId) ?? slots[0];
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && !isPaused) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [activeSlot?.logs, autoScroll, isPaused]);

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="grid grid-cols-6 gap-4">
        <StatCard icon={Video} label="Videos" value={stats.videos} tone="accent" />
        <StatCard icon={Users} label="Accounts" value={stats.accounts} tone="accent" />
        <StatCard icon={Tv} label="Channels" value={stats.channels} tone="accent" />
        <StatCard icon={CheckCircle2} label="Successful Uploads" value={stats.successfulUploads} tone="success" />
        <StatCard icon={XCircle} label="Failed Uploads" value={stats.failedUploads} tone="error" />
        <StatCard icon={Loader2} label="Uploading" value={stats.uploading} tone="accent" />
      </div>

      <GlassCard className="flex min-h-0 flex-1 flex-col" padded={false}>
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3">
          <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto">
            {slots.map((slot) => {
              const isActive = slot.id === activeSlotId;
              return (
                <button
                  key={slot.id}
                  onClick={() => setActiveSlotId(slot.id)}
                  className={clsx(
                    "flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-[12.5px] font-semibold transition-all duration-250",
                    isActive ? "text-white" : "text-white/40 hover:text-white/70",
                  )}
                  style={{
                    background: isActive ? accentGlow(0.14) : "transparent",
                    boxShadow: isActive ? `inset 0 0 0 1px ${accentGlow(0.4)}` : "none",
                  }}
                >
                  <span
                    className={clsx(
                      "h-1.5 w-1.5 rounded-full",
                      slot.state === "running" && "animate-pulse",
                    )}
                    style={{
                      background:
                        slot.state === "success"
                          ? "#34d399"
                          : slot.state === "error"
                            ? "#fb7185"
                            : slot.state === "running"
                              ? accentSolid
                              : "rgba(255,255,255,0.25)",
                      boxShadow:
                        slot.state === "running" ? `0 0 8px ${accentGlow(0.9)}` : "none",
                    }}
                  />
                  {slot.label}
                </button>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <ConsoleControlButton
              icon={isPaused ? Play : Pause}
              label={isPaused ? "Resume" : "Pause"}
              onClick={togglePause}
              active={isPaused}
            />
            <ConsoleControlButton icon={Trash2} label="Clear Logs" onClick={clearActiveSlotLogs} />
            <ConsoleControlButton
              icon={ArrowDownToLine}
              label="Auto Scroll"
              onClick={() => setAutoScroll(!autoScroll)}
              active={autoScroll}
            />
          </div>
        </div>

        <div className="relative flex-1 overflow-y-auto px-5 py-4 font-mono-terminal text-[13px] leading-relaxed">
          {!isRunning && activeSlot?.logs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-white/25">
              <span className="text-[13px]">Console idle — press Start to begin uploads</span>
            </div>
          )}
          {activeSlot?.logs.map((log) => (
            <div key={log.id} className="flex gap-3">
              <span className="shrink-0 text-white/25">[{log.time}]</span>
              <span style={{ color: LEVEL_COLOR[log.level] }}>{log.text}</span>
            </div>
          ))}
          {isRunning && !isPaused && activeSlot?.state === "running" && (
            <div className="flex gap-3 text-white/25">
              <span className="inline-block h-[14px] w-[7px] caret-blink" style={{ background: accentSolid }} />
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      </GlassCard>
    </div>
  );
}

function ConsoleControlButton({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: typeof Pause;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  const { accentSolid, accentGlow } = useTheme();
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-semibold text-white/55 transition-all duration-200 hover:text-white",
        active && "text-white",
      )}
      style={{
        background: active ? accentGlow(0.14) : "rgba(255,255,255,0.04)",
        boxShadow: active ? `inset 0 0 0 1px ${accentGlow(0.4)}` : "inset 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      <Icon size={13} strokeWidth={2.2} style={{ color: active ? accentSolid : undefined }} />
      {label}
    </button>
  );
}
