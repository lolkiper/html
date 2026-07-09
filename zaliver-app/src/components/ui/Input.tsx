import type { InputHTMLAttributes } from "react";
import { useTheme } from "../../context/ThemeContext";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function Field({ label, ...rest }: FieldProps) {
  const { accentGlow } = useTheme();
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
        {label}
      </span>
      <input
        {...rest}
        className="rounded-[12px] bg-black/25 px-3.5 py-2.5 text-[13.5px] text-white placeholder:text-white/25 outline-none transition-all duration-200"
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = `inset 0 0 0 1.5px ${accentGlow(0.9)}, 0 0 14px ${accentGlow(0.35)}`;
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,0.08)";
          rest.onBlur?.(e);
        }}
      />
    </label>
  );
}
