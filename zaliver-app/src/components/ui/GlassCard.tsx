import type { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  glow?: boolean;
  padded?: boolean;
}

export function GlassCard({
  children,
  className,
  glow = false,
  padded = true,
  style,
  ...rest
}: GlassCardProps) {
  return (
    <div
      className={clsx(
        "glass-panel rounded-[22px] shadow-[0_20px_60px_-20px_rgba(0,0,0,0.75)]",
        padded && "p-6",
        glow && "ring-1",
        className,
      )}
      style={style}
      {...rest}
    >
      {children}
    </div>
  );
}
