import clsx from "clsx";
import type { ReactNode } from "react";

type BadgeTone = "success" | "error" | "idle" | "info" | "accent";

const TONE_STYLES: Record<BadgeTone, string> = {
  success: "text-emerald-300 bg-emerald-400/10 border-emerald-400/30",
  error: "text-rose-300 bg-rose-400/10 border-rose-400/30",
  idle: "text-slate-300 bg-slate-400/10 border-slate-400/25",
  info: "text-sky-300 bg-sky-400/10 border-sky-400/30",
  accent: "text-white bg-white/10 border-white/20",
};

export function Badge({
  tone = "idle",
  children,
  dot = true,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
        TONE_STYLES[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={clsx(
            "h-1.5 w-1.5 rounded-full",
            tone === "success" && "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]",
            tone === "error" && "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]",
            tone === "idle" && "bg-slate-400",
            tone === "info" && "bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)]",
            tone === "accent" && "bg-white",
          )}
        />
      )}
      {children}
    </span>
  );
}
