import { ThemeProvider } from "./context/ThemeContext";
import { FarmProvider } from "./context/FarmContext";
import { AppShell } from "./components/layout/AppShell";

export default function App() {
  return (
    <ThemeProvider>
      <FarmProvider>
        <AppShell />
      </FarmProvider>
    </ThemeProvider>
  );
}
