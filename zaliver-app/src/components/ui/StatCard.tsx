import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "../../context/ThemeContext";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone?: "accent" | "success" | "error" | "neutral";
  suffix?: string;
}

export function StatCard({ icon: Icon, label, value, tone = "accent", suffix }: StatCardProps) {
  const { accentSolid, accentGlow } = useTheme();

  const toneColor =
    tone === "success"
      ? { solid: "#34d399", glow: "rgba(52,211,153," }
      : tone === "error"
        ? { solid: "#fb7185", glow: "rgba(251,113,133," }
        : tone === "neutral"
          ? { solid: "#cbd5e1", glow: "rgba(203,213,225," }
          : { solid: accentSolid, glow: null };

  const glowColor = (alpha: number) =>
    toneColor.glow ? `${toneColor.glow}${alpha})` : accentGlow(alpha);

  return (
    <motion.div
      whileHover={{ y: -4, transition: { duration: 0.25, ease: "easeOut" } }}
      className="glass-panel group relative overflow-hidden rounded-[20px] p-4"
      style={{
        boxShadow: `0 0 0 1px rgba(255,255,255,0.05), 0 18px 40px -22px rgba(0,0,0,0.8)`,
      }}
    >
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: `radial-gradient(circle, ${glowColor(0.25)}, transparent 70%)` }}
      />
      <div className="relative flex items-start justify-between">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-xl border transition-all duration-300"
          style={{
            borderColor: glowColor(0.35),
            background: glowColor(0.08),
            color: toneColor.solid,
          }}
        >
          <Icon size={18} strokeWidth={1.75} />
        </div>
      </div>
      <div className="relative mt-3">
        <div className="text-[26px] font-bold leading-none tracking-tight text-white">
          {value}
          {suffix && <span className="ml-1 text-sm font-medium text-white/40">{suffix}</span>}
        </div>
        <div className="mt-1.5 text-[12px] font-medium text-white/45">{label}</div>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 h-[2px] scale-x-0 transition-transform duration-500 group-hover:scale-x-100"
        style={{ background: `linear-gradient(90deg, transparent, ${toneColor.solid}, transparent)` }}
      />
    </motion.div>
  );
}
