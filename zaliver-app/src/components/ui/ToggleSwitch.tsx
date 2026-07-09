import { motion } from "framer-motion";
import clsx from "clsx";
import { useTheme } from "../../context/ThemeContext";

export function ModeToggle() {
  const { setMode, accentSolid, accentGlow, isMulti } = useTheme();

  return (
    <div
      className="app-no-drag flex items-center gap-3 rounded-full glass-panel-inset px-2 py-1.5"
      style={{ boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.05)` }}
    >
      <button
        type="button"
        onClick={() => setMode("single")}
        className={clsx(
          "relative z-10 rounded-full px-3.5 py-1.5 text-[12px] font-semibold tracking-wide transition-colors duration-300",
          !isMulti ? "text-white" : "text-white/40 hover:text-white/70",
        )}
      >
        Single Upload
      </button>

      <div
        className="relative h-7 w-[52px] cursor-pointer rounded-full bg-black/40"
        onClick={() => setMode(isMulti ? "single" : "multi")}
        style={{ boxShadow: `inset 0 0 10px rgba(0,0,0,0.6)` }}
      >
        <motion.div
          className="absolute top-0.5 h-6 w-6 rounded-full"
          style={{
            background: accentSolid,
            boxShadow: `0 0 14px ${accentGlow(0.9)}, 0 0 4px ${accentGlow(1)}`,
          }}
          animate={{ left: isMulti ? 22 : 2 }}
          transition={{ duration: 0.4, ease: [0.25, 0.8, 0.25, 1] }}
        />
      </div>

      <button
        type="button"
        onClick={() => setMode("multi")}
        className={clsx(
          "relative z-10 rounded-full px-3.5 py-1.5 text-[12px] font-semibold tracking-wide transition-colors duration-300",
          isMulti ? "text-white" : "text-white/40 hover:text-white/70",
        )}
      >
        Multi Upload <span className="opacity-60">(10)</span>
      </button>
    </div>
  );
}
