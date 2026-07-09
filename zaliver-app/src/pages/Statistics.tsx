import { GlassCard } from "../components/ui/GlassCard";
import { Badge } from "../components/ui/Badge";
import { CircularGauge } from "../components/ui/CircularGauge";
import { MOCK_CHANNELS } from "../data/mockData";
import type { ChannelStatus } from "../types";

const STATUS_TONE: Record<ChannelStatus, "success" | "error" | "idle"> = {
  success: "success",
  failed: "error",
  idle: "idle",
};

const STATUS_LABEL: Record<ChannelStatus, string> = {
  success: "Success",
  failed: "Failed",
  idle: "Idle",
};

function formatNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function Statistics() {
  const successRate = Math.round(
    (MOCK_CHANNELS.filter((c) => c.status === "success").length / MOCK_CHANNELS.length) * 100,
  );
  const totalViews = MOCK_CHANNELS.reduce((sum, c) => sum + c.views, 0);
  const totalSubs = MOCK_CHANNELS.reduce((sum, c) => sum + c.subscribers, 0);

  return (
    <div className="flex h-full gap-5">
      <GlassCard className="flex-1 overflow-hidden" padded={false}>
        <div className="h-full overflow-y-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-black/40 backdrop-blur-md">
              <tr>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">#</th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">Channel Name</th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">Subscribers</th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">Views</th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">Last Upload</th>
                <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">Status</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_CHANNELS.map((channel, idx) => (
                <tr
                  key={channel.id}
                  className="border-t border-white/[0.05] transition-colors duration-200 hover:bg-white/[0.03]"
                >
                  <td className="px-5 py-3.5 text-[13.5px] text-white/40">
                    {String(idx + 1).padStart(2, "0")}
                  </td>
                  <td className="px-5 py-3.5 text-[13.5px] font-semibold text-white">
                    {channel.channelName}
                  </td>
                  <td className="px-5 py-3.5 text-[13.5px] text-white/75">
                    {formatNumber(channel.subscribers)}
                  </td>
                  <td className="px-5 py-3.5 text-[13.5px] text-white/75">
                    {formatNumber(channel.views)}
                  </td>
                  <td className="px-5 py-3.5 text-[13.5px] text-white/50">{channel.lastUpload}</td>
                  <td className="px-5 py-3.5">
                    <Badge tone={STATUS_TONE[channel.status]}>{STATUS_LABEL[channel.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>

      <GlassCard className="flex w-[280px] shrink-0 flex-col items-center justify-center gap-6">
        <CircularGauge value={successRate} />
        <div className="grid w-full grid-cols-2 gap-3 border-t border-white/[0.06] pt-5">
          <div className="text-center">
            <div className="text-[18px] font-bold text-white">{formatNumber(totalSubs)}</div>
            <div className="text-[10.5px] uppercase tracking-wide text-white/35">Subscribers</div>
          </div>
          <div className="text-center">
            <div className="text-[18px] font-bold text-white">{formatNumber(totalViews)}</div>
            <div className="text-[10.5px] uppercase tracking-wide text-white/35">Total Views</div>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
