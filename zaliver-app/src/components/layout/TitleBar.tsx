import { Minus, Square, X } from "lucide-react";
import { getBridge } from "../../lib/electronBridge";

export function TitleBar() {
  const bridge = getBridge();

  return (
    <div className="app-drag-region flex h-8 items-center justify-end px-3">
      <div className="app-no-drag flex items-center gap-1">
        <button
          onClick={() => bridge?.minimize()}
          className="flex h-7 w-9 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <Minus size={13} />
        </button>
        <button
          onClick={() => bridge?.maximize()}
          className="flex h-7 w-9 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <Square size={11} />
        </button>
        <button
          onClick={() => bridge?.close()}
          className="flex h-7 w-9 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-rose-500 hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
