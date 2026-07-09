import { Play, Square as StopIcon } from "lucide-react";
import logo from "../../assets/zaliver-logo.png";
import { ModeToggle } from "../ui/ToggleSwitch";
import { GlowButton } from "../ui/GlowButton";
import { useTheme } from "../../context/ThemeContext";

export function TopBar({
  isRunning,
  onStart,
  onStop,
}: {
  isRunning: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const { accentGlow } = useTheme();

  return (
    <header className="app-drag-region flex h-[76px] shrink-0 items-center justify-between border-b border-white/[0.06] px-6">
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[12px]"
          style={{ boxShadow: `0 0 22px ${accentGlow(0.45)}` }}
        >
          <img src={logo} alt="YouTube Zaliver" className="h-full w-full object-cover" />
        </div>
        <div className="leading-tight">
          <div className="text-[15.5px] font-bold tracking-tight text-gradient-brand">
            YouTube Zaliver
          </div>
          <div className="text-[11px] font-medium text-white/35">Upload Automation Suite</div>
        </div>
      </div>

      <ModeToggle />

      <div className="app-no-drag flex items-center gap-3">
        <GlowButton
          icon={Play}
          variant="success"
          onClick={onStart}
          disabled={isRunning}
        >
          Start
        </GlowButton>
        <GlowButton
          icon={StopIcon}
          variant="danger"
          onClick={onStop}
          disabled={!isRunning}
        >
          Stop
        </GlowButton>
      </div>
    </header>
  );
}
