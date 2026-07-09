import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import clsx from "clsx";
import { useTheme } from "../../context/ThemeContext";

type Variant = "accent" | "success" | "danger" | "ghost";

type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart" | "onAnimationEnd"
>;

interface GlowButtonProps extends NativeButtonProps {
  icon?: LucideIcon;
  variant?: Variant;
  size?: "md" | "lg";
}

export function GlowButton({
  icon: Icon,
  variant = "accent",
  size = "md",
  className,
  children,
  disabled,
  ...rest
}: GlowButtonProps) {
  const { accentSolid, accentGlow } = useTheme();

  const palette =
    variant === "success"
      ? { solid: "#22c55e", soft: "rgba(34,197,94,", text: "#04140a" }
      : variant === "danger"
        ? { solid: "#f43f5e", soft: "rgba(244,63,94,", text: "#ffffff" }
        : variant === "ghost"
          ? { solid: "rgba(255,255,255,0.12)", soft: "rgba(255,255,255,", text: "#ffffff" }
          : { solid: accentSolid, soft: null, text: "#0a0510" };

  const glow = (alpha: number) => (palette.soft ? `${palette.soft}${alpha})` : accentGlow(alpha));

  return (
    <motion.button
      whileHover={disabled ? undefined : { y: -2, scale: 1.01 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={{ duration: 0.18 }}
      disabled={disabled}
      className={clsx(
        "app-no-drag relative flex items-center justify-center gap-2 overflow-hidden rounded-2xl font-semibold uppercase tracking-wide transition-opacity",
        size === "lg" ? "px-8 py-4 text-[14px]" : "px-5 py-2.5 text-[13px]",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
      style={{
        background:
          variant === "ghost"
            ? "rgba(255,255,255,0.06)"
            : `linear-gradient(135deg, ${palette.solid}, ${variant === "accent" ? accentGlow(1) : palette.solid})`,
        color: variant === "ghost" ? "#ffffff" : palette.text,
        boxShadow: disabled
          ? "none"
          : variant === "ghost"
            ? "inset 0 0 0 1px rgba(255,255,255,0.1)"
            : `0 0 0 1px ${glow(0.4)}, 0 8px 24px -6px ${glow(0.55)}, inset 0 1px 0 rgba(255,255,255,0.25)`,
      }}
      {...rest}
    >
      {Icon && <Icon size={size === "lg" ? 20 : 16} strokeWidth={2.25} />}
      {children}
    </motion.button>
  );
}
