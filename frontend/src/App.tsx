import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Reading {
  timestamp: string;
  count: number;
}

interface Stats {
  current: number;
  peak: number;
  avg_now: number;
  diff_from_avg: number;
  last_updated: string;
}

interface Predicted {
  hour: number;
  avg: number;
  max: number;
  min: number;
}

interface HeatmapSlotData {
  day_of_week: number;
  slot: number;
  avg: number;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TZ_OFFSET = Math.round(-new Date().getTimezoneOffset() / 60);
const Y_AXIS_WIDTH = 30;

function formatTime(ts: string) {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function api<T>(path: string): Promise<T | null> {
  try {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${path}${sep}tz_offset=${TZ_OFFSET}`);
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

function Heatmap({ data, currentSlot }: { data: HeatmapSlotData[]; currentSlot: number }) {
  const [hover, setHover] = useState<{ day: string; slot: number; val: number; x: number; y: number } | null>(null);
  const SLOTS = 48;
  const grid: number[][] = Array.from({ length: 7 }, () => Array(SLOTS).fill(0));
  let max = 1;
  for (const d of data) {
    grid[d.day_of_week][d.slot] = d.avg;
    if (d.avg > max) max = d.avg;
  }

  const currentPct = (currentSlot / SLOTS) * 100;

  return (
    <div className="relative">
      {hover && (
        <div
          className="fixed pointer-events-none z-50 border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs whitespace-nowrap"
          style={{ left: hover.x + 12, top: hover.y - 24 }}
        >
          {hover.day} {Math.floor(hover.slot / 2).toString().padStart(2, "0")}:{hover.slot % 2 === 0 ? "00" : "30"} avg {Math.round(hover.val)}
        </div>
      )}
      <div
        className="absolute top-0 bottom-0 w-px bg-red-500 z-10 pointer-events-none"
        style={{ left: `${currentPct}%` }}
      />
      {DAYS.map((day, di) => (
        <div key={day} className="flex h-[12px]">
          {Array.from({ length: SLOTS }, (_, s) => {
            const val = grid[di][s];
            const intensity = val / max;
            return (
              <div
                key={s}
                className="flex-1 cursor-crosshair"
                style={{ backgroundColor: `rgba(255,255,255,${intensity * 0.85})` }}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setHover({ day, slot: s, val, x: rect.right, y: rect.top });
                }}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </div>
      ))}
      <div className="flex mt-0.5">
        {Array.from({ length: 24 }, (_, i) => (
          <div key={i} className="flex-1 text-center text-[var(--muted-foreground)] text-[9px]">
            {i % 2 === 0 ? i.toString().padStart(2, "0") : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function TodayChart({ today, predicted }: { today: Reading[]; predicted: Predicted[] }) {
  const now = new Date();
  const currentTime = now.getHours() + now.getMinutes() / 60;
  const TOTAL_HOURS = 30;

  const points: { time: number; actual: number | null; predicted: number | null; predictedMax: number | null; predictedMin: number | null }[] = [];

  for (const pred of predicted) {
    points.push({
      time: pred.hour,
      actual: null,
      predicted: pred.avg,
      predictedMax: pred.max,
      predictedMin: pred.min,
    });
  }

  for (const r of today) {
    const d = new Date(r.timestamp);
    const t = d.getHours() + d.getMinutes() / 60;
    points.push({
      time: t,
      actual: r.count,
      predicted: null,
      predictedMax: null,
      predictedMin: null,
    });
  }

  points.sort((a, b) => a.time - b.time);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={points} margin={{ left: 0, right: 0, top: 5, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="var(--border)" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          stroke="var(--border)"
          type="number"
          domain={[0, TOTAL_HOURS]}
          ticks={[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]}
          tickFormatter={(h) => (h % 24).toString().padStart(2, "0")}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          stroke="var(--border)"
          width={Y_AXIS_WIDTH}
        />
        <Tooltip
          contentStyle={{
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: 0,
            fontSize: 11,
            fontFamily: "inherit",
          }}
          labelFormatter={(t) => {
            const h = Math.floor(Number(t) % 24);
            const m = Math.round((Number(t) % 1) * 60);
            return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
          }}
        />
        <ReferenceLine x={24} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="4 2" />
        <ReferenceLine x={currentTime} stroke="#ef4444" strokeWidth={1.5} />
        <Area type="monotone" dataKey="predictedMax" stroke="none" fill="var(--foreground)" fillOpacity={0.05} connectNulls />
        <Area type="monotone" dataKey="predictedMin" stroke="none" fill="var(--background)" fillOpacity={1} connectNulls />
        <Line type="monotone" dataKey="predicted" stroke="var(--muted-foreground)" strokeDasharray="4 2" strokeWidth={1} dot={false} connectNulls />
        <Line type="linear" dataKey="actual" stroke="var(--foreground)" strokeWidth={2} dot={{ r: 2, fill: "var(--foreground)" }} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [today, setToday] = useState<Reading[]>([]);
  const [predicted, setPredicted] = useState<Predicted[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapSlotData[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [s, t, p, h] = await Promise.all([
        api<Stats>("/api/stats"),
        api<Reading[]>("/api/today"),
        api<Predicted[]>("/api/predicted"),
        api<HeatmapSlotData[]>("/api/heatmap"),
      ]);
      if (s === null && t === null && h === null) {
        setError(true);
        return;
      }
      setError(false);
      if (s) setStats(s);
      if (t) setToday(t);
      if (p) setPredicted(p);
      if (h) setHeatmap(h);
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  const now = new Date();
  const currentHour = now.getHours();
  const currentDow = (now.getDay() - 1 + 7) % 7;
  const pctOfPeak = stats && stats.peak > 0 ? Math.round((stats.current / stats.peak) * 100) : 0;

  const quietestUpcoming = predicted
    .filter((p) => p.hour > currentHour && p.hour < 24)
    .sort((a, b) => a.avg - b.avg)[0];

  // Chart is 30/24 = 125% of the heatmap width.
  // Chart's Y-axis (30px) sits to the left of the plot area.
  // So chart total width = Y_AXIS_WIDTH + plotArea.
  // We want plotArea's 0-24 region = heatmap width.
  // plotArea covers 0-30, so 24h portion = 80% of plotArea.
  // We need: 0.8 * plotArea = heatmapWidth => plotArea = 1.25 * heatmapWidth.
  // chartTotalWidth = Y_AXIS_WIDTH + 1.25 * heatmapWidth.
  // As a percentage of heatmapWidth: (Y_AXIS_WIDTH / heatmapWidth + 1.25) * 100%.
  // With a CSS calc: width = calc(125% + Y_AXIS_WIDTH px), margin-left = -Y_AXIS_WIDTH.

  return (
    <div className="m-8 flex flex-col gap-4" style={{ width: "calc(100vw - 4rem)", maxWidth: 1000 }}>
        <header className="flex items-baseline justify-between border-b border-[var(--border)] pb-2">
          <h1 className="text-sm font-semibold tracking-tight">purergym</h1>
          {error && <span className="text-[var(--muted-foreground)]">offline</span>}
          {!error && stats && (
            <span className="text-[var(--muted-foreground)]">
              updated {formatTime(stats.last_updated)}
            </span>
          )}
        </header>

        {stats && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-6 items-baseline">
              <div>
                <span className="text-2xl font-bold tabular-nums">{stats.current}</span>
                <span className="text-[var(--muted-foreground)]"> / {stats.peak} peak</span>
              </div>
              <div className="flex-1 h-2 bg-[var(--muted)]">
                <div
                  className="h-full bg-[var(--foreground)] transition-all"
                  style={{ width: `${pctOfPeak}%` }}
                />
              </div>
              <span className="tabular-nums font-medium">{pctOfPeak}%</span>
            </div>
            <div className="flex gap-4 text-[var(--muted-foreground)]">
              <span>
                avg for {currentHour.toString().padStart(2, "0")}:00 {DAYS[currentDow]}:{" "}
                <span className="text-[var(--foreground)] font-medium">{stats.avg_now}</span>
              </span>
              <span>
                {stats.diff_from_avg > 0 ? "+" : ""}
                {stats.diff_from_avg} vs avg
              </span>
              {quietestUpcoming && (
                <span>
                  quietest upcoming:{" "}
                  <span className="text-[var(--foreground)] font-medium">
                    {(quietestUpcoming.hour % 24).toString().padStart(2, "0")}:00
                  </span>{" "}
                  (~{Math.round(quietestUpcoming.avg)})
                </span>
              )}
            </div>
          </div>
        )}

        <section className="overflow-visible">
          <h2 className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1">
            Today vs predicted
          </h2>
          <div
            className="h-48"
            style={{ width: `calc(125% - 8px)` }}
          >
            {predicted.length > 0 ? (
              <TodayChart today={today} predicted={predicted} />
            ) : (
              <div className="h-full flex items-center justify-center text-[var(--muted-foreground)]">
                collecting data...
              </div>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-1">
            Weekly avg
          </h2>
          <div className="flex">
            <div className="shrink-0 flex flex-col justify-around" style={{ width: Y_AXIS_WIDTH }}>
              {DAYS.map((day) => (
                <span key={day} className="text-[9px] text-[var(--muted-foreground)] text-right pr-1 leading-[12px]">{day}</span>
              ))}
            </div>
            <div className="flex-1">
              {heatmap.length > 0 ? (
                <Heatmap data={heatmap} currentSlot={currentHour * 2 + (now.getMinutes() >= 30 ? 1 : 0)} />
              ) : (
                <div className="text-[var(--muted-foreground)]">collecting data...</div>
              )}
            </div>
          </div>
        </section>
    </div>
  );
}
