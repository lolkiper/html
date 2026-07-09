import { useState } from "react";
import { Play, Square as StopIcon, Save, ShieldCheck } from "lucide-react";
import { GlassCard } from "../components/ui/GlassCard";
import { Field } from "../components/ui/Input";
import { Checkbox } from "../components/ui/Checkbox";
import { GlowButton } from "../components/ui/GlowButton";
import { useFarm } from "../context/FarmContext";
import { ACCOUNTS_TXT_PLACEHOLDER } from "../data/mockData";

export function AutoLogin() {
  const { isRunning, start, stop } = useFarm();
  const [skipOk, setSkipOk] = useState(true);
  const [accountsText, setAccountsText] = useState("");

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="grid flex-1 grid-cols-2 gap-5">
        <GlassCard className="flex flex-col gap-5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-white/50" />
            <h2 className="text-[14px] font-bold text-white">Settings</h2>
          </div>

          <Field label="Dolphin Token" type="password" placeholder="API token…" />
          <Field label="Local API URL" defaultValue="http://localhost:3001" />
          <Field label="Cloud API URL" defaultValue="https://dolphin-anty-api.com" />
          <Field label="2FA Website URL" defaultValue="https://2fa.fb.tools/" />
          <Field label="Delay Between Accounts (ms)" type="number" defaultValue={5000} min={0} step={500} />

          <Checkbox checked={skipOk} onChange={setSkipOk} label="Skip Already Successful" />

          <div className="mt-auto pt-2">
            <GlowButton icon={Save} variant="ghost" className="w-full">
              Save Settings
            </GlowButton>
          </div>
        </GlassCard>

        <GlassCard className="flex flex-col gap-4">
          <div>
            <h2 className="text-[14px] font-bold text-white">Accounts (accounts.txt)</h2>
            <p className="mt-1 text-[11.5px] text-white/35">
              Format: EMAIL|PASSWORD|TOTP_SECRET|HOST:PORT:LOGIN:PASS:HTTP
            </p>
          </div>

          <textarea
            value={accountsText}
            onChange={(e) => setAccountsText(e.target.value)}
            placeholder={ACCOUNTS_TXT_PLACEHOLDER}
            className="flex-1 resize-none rounded-[14px] bg-black/25 p-4 font-mono-terminal text-[12.5px] leading-relaxed text-white placeholder:text-white/20 outline-none"
            style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
          />

          <GlowButton icon={Save} variant="ghost" className="w-full">
            Save accounts.txt
          </GlowButton>
        </GlassCard>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <GlowButton
          icon={Play}
          variant="success"
          size="lg"
          className="w-full"
          onClick={start}
          disabled={isRunning}
        >
          Start
        </GlowButton>
        <GlowButton
          icon={StopIcon}
          variant="danger"
          size="lg"
          className="w-full"
          onClick={stop}
          disabled={!isRunning}
        >
          Stop
        </GlowButton>
      </div>
    </div>
  );
}
