import { Check } from "lucide-react";
import { useTheme } from "../../context/ThemeContext";

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  const { accentSolid, accentGlow } = useTheme();
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-[13px] font-medium text-white/70 transition-colors hover:text-white"
    >
      <span
        className="flex h-[18px] w-[18px] items-center justify-center rounded-[6px] transition-all duration-200"
        style={{
          background: checked ? accentSolid : "rgba(255,255,255,0.05)",
          boxShadow: checked
            ? `0 0 10px ${accentGlow(0.7)}`
            : "inset 0 0 0 1px rgba(255,255,255,0.15)",
        }}
      >
        {checked && <Check size={12} strokeWidth={3} className="text-black" />}
      </span>
      {label}
    </button>
  );
}
