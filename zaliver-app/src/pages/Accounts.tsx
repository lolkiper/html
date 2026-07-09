import { useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { GlassCard } from "../components/ui/GlassCard";
import { Badge } from "../components/ui/Badge";
import { GlowButton } from "../components/ui/GlowButton";
import { MOCK_ACCOUNTS } from "../data/mockData";
import type { Account, AccountStatus } from "../types";

const STATUS_TONE: Record<AccountStatus, "success" | "error" | "idle" | "info"> = {
  active: "success",
  banned: "error",
  idle: "idle",
  checking: "info",
};

const STATUS_LABEL: Record<AccountStatus, string> = {
  active: "Active",
  banned: "Banned",
  idle: "Idle",
  checking: "Checking",
};

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>(MOCK_ACCOUNTS);
  const nextId = () => (accounts.length ? Math.max(...accounts.map((a) => a.id)) + 1 : 1);

  const addAccount = () => {
    setAccounts((prev) => [
      ...prev,
      { id: nextId(), browserId: "—", status: "idle" },
    ]);
  };

  const removeAccount = (id: number) => {
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[18px] font-bold text-white">Accounts</h1>
          <p className="text-[12.5px] text-white/40">{accounts.length} browser profiles connected</p>
        </div>
        <GlowButton icon={Plus} onClick={addAccount}>
          Add Account
        </GlowButton>
      </div>

      <GlassCard className="flex-1 overflow-hidden" padded={false}>
        <div className="h-full overflow-y-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-black/40 backdrop-blur-md">
              <tr>
                <Th className="w-20">#</Th>
                <Th>Browser ID</Th>
                <Th className="w-40">Status</Th>
                <Th className="w-24 text-right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account, idx) => (
                <tr
                  key={account.id}
                  className="border-t border-white/[0.05] transition-colors duration-200 hover:bg-white/[0.03]"
                >
                  <Td className="text-white/40">{String(idx + 1).padStart(2, "0")}</Td>
                  <Td className="font-mono-terminal text-[13px] text-white/85">
                    {account.browserId}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[account.status]}>
                      {STATUS_LABEL[account.status]}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    <button
                      onClick={() => removeAccount(account.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
                    >
                      <Trash2 size={15} />
                    </button>
                  </Td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-16 text-center text-[13px] text-white/30">
                    No accounts yet — click “Add Account” to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}

function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={`px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-white/40 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-5 py-3.5 text-[13.5px] ${className}`}>{children}</td>;
}
