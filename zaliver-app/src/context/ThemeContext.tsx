import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { animate, useMotionValue } from "framer-motion";
import type { UploadMode } from "../types";

const PURPLE_RGB = { r: 139, g: 92, b: 246 }; // #8B5CF6
const GREEN_RGB = { r: 0, g: 255, b: 136 }; // #00FF88

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

interface ThemeContextValue {
  mode: UploadMode;
  setMode: (mode: UploadMode) => void;
  toggleMode: () => void;
  isMulti: boolean;
  accentRgb: { r: number; g: number; b: number };
  accentSolid: string;
  accentGlow: (alpha: number) => string;
  accentHex: string;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UploadMode>("single");
  const progress = useMotionValue(0);
  const [rgb, setRgb] = useState(PURPLE_RGB);

  useEffect(() => {
    const unsubscribe = progress.on("change", (v) => {
      setRgb({
        r: Math.round(lerp(PURPLE_RGB.r, GREEN_RGB.r, v)),
        g: Math.round(lerp(PURPLE_RGB.g, GREEN_RGB.g, v)),
        b: Math.round(lerp(PURPLE_RGB.b, GREEN_RGB.b, v)),
      });
    });
    return () => unsubscribe();
  }, [progress]);

  const setMode = (next: UploadMode) => {
    setModeState(next);
    animate(progress, next === "multi" ? 1 : 0, {
      duration: 0.45,
      ease: [0.25, 0.8, 0.25, 1],
    });
  };

  const toggleMode = () => setMode(mode === "single" ? "multi" : "single");

  const value = useMemo<ThemeContextValue>(() => {
    const accentSolid = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    const accentHex =
      "#" +
      [rgb.r, rgb.g, rgb.b]
        .map((c) => c.toString(16).padStart(2, "0"))
        .join("");
    return {
      mode,
      setMode,
      toggleMode,
      isMulti: mode === "multi",
      accentRgb: rgb,
      accentSolid,
      accentGlow: (alpha: number) => `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`,
      accentHex,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, rgb]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
