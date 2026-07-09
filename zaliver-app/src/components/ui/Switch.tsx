import { motion } from "framer-motion";
import { useTheme } from "../../context/ThemeContext";

export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { accentSolid, accentGlow } = useTheme();
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="relative h-6 w-[42px] rounded-full transition-colors duration-300"
      style={{
        background: checked ? accentGlow(0.9) : "rgba(255,255,255,0.1)",
        boxShadow: checked ? `0 0 10px ${accentGlow(0.5)}` : "inset 0 0 4px rgba(0,0,0,0.4)",
      }}
    >
      <motion.span
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white"
        animate={{ left: checked ? 19 : 2 }}
        transition={{ duration: 0.3, ease: [0.25, 0.8, 0.25, 1] }}
        style={{ boxShadow: checked ? `0 0 8px ${accentSolid}` : "none" }}
      />
    </button>
  );
}
