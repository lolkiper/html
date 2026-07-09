import {
  LayoutDashboard,
  KeyRound,
  Users,
  Type,
  BarChart3,
  Settings as SettingsIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import { motion } from "framer-motion";
import type { NavKey } from "../../types";
import { useTheme } from "../../context/ThemeContext";

interface NavItem {
  key: NavKey;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "autologin", label: "AutoLogin", icon: KeyRound },
  { key: "accounts", label: "Accounts", icon: Users },
  { key: "titles", label: "Titles", icon: Type },
  { key: "statistics", label: "Statistics", icon: BarChart3 },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];

export function Sidebar({
  active,
  onNavigate,
}: {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
}) {
  const { accentSolid, accentGlow } = useTheme();

  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col gap-1 border-r border-white/[0.06] px-3 py-5">
      <div className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">
        Workspace
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active;
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              className={clsx(
                "group relative flex items-center gap-3 rounded-[14px] px-3.5 py-2.5 text-left text-[13.5px] font-medium transition-all duration-300",
                isActive ? "text-white" : "text-white/50 hover:text-white/85",
              )}
              style={{
                background: isActive ? accentGlow(0.12) : "transparent",
                boxShadow: isActive
                  ? `inset 0 0 0 1px ${accentGlow(0.35)}, 0 0 22px -6px ${accentGlow(0.55)}`
                  : "none",
              }}
            >
              {isActive && (
                <motion.span
                  layoutId="sidebar-active-bar"
                  className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full"
                  style={{ background: accentSolid, boxShadow: `0 0 10px ${accentGlow(0.9)}` }}
                  transition={{ duration: 0.35, ease: [0.25, 0.8, 0.25, 1] }}
                />
              )}
              <Icon
                size={17}
                strokeWidth={1.9}
                style={{ color: isActive ? accentSolid : undefined }}
                className={clsx(!isActive && "text-white/45 group-hover:text-white/70")}
              />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto px-3 pb-1">
        <div className="glass-panel-inset rounded-[14px] px-3.5 py-3">
          <div className="text-[11px] font-semibold text-white/70">YouTube Zaliver</div>
          <div className="mt-0.5 text-[10.5px] text-white/35">v2.0.0 — Ultra Edition</div>
        </div>
      </div>
    </aside>
  );
}
