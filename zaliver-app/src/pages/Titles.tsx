import { useRef, useState } from "react";
import { Upload, Trash2, Shuffle as ShuffleIcon } from "lucide-react";
import { GlassCard } from "../components/ui/GlassCard";
import { GlowButton } from "../components/ui/GlowButton";
import { MOCK_TITLES } from "../data/mockData";

function shuffleLines(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  return lines.join("\n");
}

export function Titles() {
  const [value, setValue] = useState(MOCK_TITLES.join("\n"));
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const lines = value.split("\n");

  const syncScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleImport = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setValue(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[18px] font-bold text-white">Titles</h1>
          <p className="text-[12.5px] text-white/40">{lines.length} lines loaded</p>
        </div>
        <div className="flex items-center gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt"
            className="hidden"
            onChange={(e) => handleImport(e.target.files?.[0])}
          />
          <GlowButton icon={Upload} variant="ghost" onClick={() => fileInputRef.current?.click()}>
            Import TXT
          </GlowButton>
          <GlowButton icon={ShuffleIcon} variant="ghost" onClick={() => setValue((v) => shuffleLines(v))}>
            Shuffle
          </GlowButton>
          <GlowButton icon={Trash2} variant="ghost" onClick={() => setValue("")}>
            Clear
          </GlowButton>
        </div>
      </div>

      <GlassCard className="flex flex-1 overflow-hidden" padded={false}>
        <div
          ref={gutterRef}
          className="no-scrollbar select-none overflow-y-hidden px-4 py-4 text-right font-mono-terminal text-[13px] leading-relaxed text-white/25"
          style={{ borderRight: "1px solid rgba(255,255,255,0.06)" }}
        >
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          className="flex-1 resize-none bg-transparent px-4 py-4 font-mono-terminal text-[13px] leading-relaxed text-white outline-none"
          placeholder="One title per line…"
        />
      </GlassCard>
    </div>
  );
}
