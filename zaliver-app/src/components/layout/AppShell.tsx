import { AnimatePresence, motion } from "framer-motion";
import { useState, type ComponentType } from "react";
import { TitleBar } from "./TitleBar";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { Dashboard } from "../../pages/Dashboard";
import { AutoLogin } from "../../pages/AutoLogin";
import { Accounts } from "../../pages/Accounts";
import { Titles } from "../../pages/Titles";
import { Statistics } from "../../pages/Statistics";
import { Settings } from "../../pages/Settings";
import { useFarm } from "../../context/FarmContext";
import type { NavKey } from "../../types";

const PAGES: Record<NavKey, ComponentType> = {
  dashboard: Dashboard,
  autologin: AutoLogin,
  accounts: Accounts,
  titles: Titles,
  statistics: Statistics,
  settings: Settings,
};

export function AppShell() {
  const [active, setActive] = useState<NavKey>("dashboard");
  const { isRunning, start, stop } = useFarm();

  const ActivePage = PAGES[active];

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden">
      <div className="app-backdrop" />
      <div className="relative z-10 flex h-full flex-col">
        <TitleBar />
        <TopBar isRunning={isRunning} onStart={start} onStop={stop} />
        <div className="flex min-h-0 flex-1">
          <Sidebar active={active} onNavigate={setActive} />
          <main className="min-w-0 flex-1 overflow-hidden p-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: [0.25, 0.8, 0.25, 1] }}
                className="h-full"
              >
                <ActivePage />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </div>
  );
}
