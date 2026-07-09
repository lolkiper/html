import { useState, type ReactNode } from "react";
import { Save, Sparkles } from "lucide-react";
import { GlassCard } from "../components/ui/GlassCard";
import { Field } from "../components/ui/Input";
import { Switch } from "../components/ui/Switch";
import { GlowButton } from "../components/ui/GlowButton";
import { useTheme } from "../context/ThemeContext";

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <div>
        <div className="text-[13.5px] font-semibold text-white">{title}</div>
        <div className="mt-0.5 text-[12px] text-white/40">{description}</div>
      </div>
      {children}
    </div>
  );
}

export function Settings() {
  const { setMode, accentSolid } = useTheme();
  const [reduceMotion, setReduceMotion] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [autoStart, setAutoStart] = useState(false);

  return (
    <div className="grid h-full grid-cols-2 gap-5 overflow-y-auto pr-1">
      <div className="flex flex-col gap-5">
        <GlassCard>
          <h2 className="mb-1 text-[14px] font-bold text-white">General</h2>
          <div className="divide-y divide-white/[0.06]">
            <SettingRow title="Reduce Motion" description="Minimize animated transitions across the app">
              <Switch checked={reduceMotion} onChange={setReduceMotion} />
            </SettingRow>
            <SettingRow title="Desktop Notifications" description="Alert when uploads finish or fail">
              <Switch checked={notifications} onChange={setNotifications} />
            </SettingRow>
            <SettingRow title="Launch on Startup" description="Open Zaliver automatically with your system">
              <Switch checked={autoStart} onChange={setAutoStart} />
            </SettingRow>
          </div>
        </GlassCard>

        <GlassCard className="flex-1">
          <h2 className="mb-4 text-[14px] font-bold text-white">Automation</h2>
          <div className="flex flex-col gap-4">
            <Field label="Videos Folder Path" defaultValue="C:\\Users\\PC\\yt-farm\\videos" />
            <Field label="Concurrency Limit" type="number" defaultValue={6} min={1} max={12} />
          </div>
        </GlassCard>
      </div>

      <div className="flex flex-col gap-5">
        <GlassCard>
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={15} style={{ color: accentSolid }} />
            <h2 className="text-[14px] font-bold text-white">Accent Preview</h2>
          </div>
          <p className="mb-4 text-[12px] text-white/40">
            The interface accent transitions automatically with upload mode.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => setMode("single")}
              className="flex-1 rounded-[14px] border border-white/10 p-4 text-left transition-transform duration-200 hover:-translate-y-0.5"
              style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.18), rgba(139,92,246,0.03))" }}
            >
              <div className="h-6 w-6 rounded-full" style={{ background: "#8B5CF6", boxShadow: "0 0 14px rgba(139,92,246,0.7)" }} />
              <div className="mt-2 text-[12.5px] font-semibold text-white">Single Upload</div>
              <div className="text-[11px] text-white/40">Neon Purple #8B5CF6</div>
            </button>
            <button
              onClick={() => setMode("multi")}
              className="flex-1 rounded-[14px] border border-white/10 p-4 text-left transition-transform duration-200 hover:-translate-y-0.5"
              style={{ background: "linear-gradient(135deg, rgba(0,255,136,0.16), rgba(0,255,136,0.02))" }}
            >
              <div className="h-6 w-6 rounded-full" style={{ background: "#00FF88", boxShadow: "0 0 14px rgba(0,255,136,0.7)" }} />
              <div className="mt-2 text-[12.5px] font-semibold text-white">Multi Upload</div>
              <div className="text-[11px] text-white/40">Neon Green #00FF88</div>
            </button>
          </div>
        </GlassCard>

        <GlassCard className="flex-1">
          <h2 className="mb-1 text-[14px] font-bold text-white">About</h2>
          <p className="mb-4 text-[12px] text-white/40">YouTube Zaliver — Upload Automation Suite</p>
          <div className="flex items-center justify-between rounded-[14px] bg-black/25 px-4 py-3">
            <span className="text-[12.5px] text-white/60">Version</span>
            <span className="text-[12.5px] font-semibold text-white">2.0.0 Ultra Edition</span>
          </div>
          <div className="mt-4">
            <GlowButton icon={Save} variant="ghost" className="w-full">
              Save Settings
            </GlowButton>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
