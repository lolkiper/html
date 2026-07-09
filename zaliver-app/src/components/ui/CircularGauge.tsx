import { motion } from "framer-motion";
import { useTheme } from "../../context/ThemeContext";

export function CircularGauge({
  value,
  size = 176,
  strokeWidth = 14,
  label = "Success Rate",
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
}) {
  const { accentSolid, accentGlow } = useTheme();
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={strokeWidth}
          />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={accentSolid}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1.1, ease: [0.25, 0.8, 0.25, 1] }}
            style={{ filter: `drop-shadow(0 0 10px ${accentGlow(0.7)})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[32px] font-bold text-white">{value}%</span>
          <span className="text-[11px] font-medium uppercase tracking-wide text-white/40">
            Success
          </span>
        </div>
      </div>
      <div className="text-[13px] font-medium text-white/50">{label}</div>
    </div>
  );
}
