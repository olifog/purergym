import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Reading {
  timestamp: string;
  count: number;
  capacity: number;
}

interface Stats {
  current: number;
  capacity: number;
  last_updated: string;
}

interface HourlyAvg {
  hour: number;
  avg: number;
  day_of_week: number;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TZ_OFFSET = Math.round(-new Date().getTimezoneOffset() / 60);

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

function Heatmap({ data }: { data: HourlyAvg[] }) {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 1;
  for (const d of data) {
    grid[d.day_of_week][d.hour] = d.avg;
    if (d.avg > max) max = d.avg;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="p-0 text-left w-8" />
            {Array.from({ length: 24 }, (_, i) => (
              <th
                key={i}
                className="p-0 font-normal text-[var(--muted-foreground)] text-center w-[calc((100%-2rem)/24)]"
              >
                {i.toString().padStart(2, "0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAYS.map((day, di) => (
            <tr key={day}>
              <td className="p-0 pr-1 text-[var(--muted-foreground)]">{day}</td>
              {Array.from({ length: 24 }, (_, h) => {
                const val = grid[di][h];
                const intensity = val / max;
                return (
                  <td key={h} className="p-0" title={`${day} ${h}:00 — avg ${Math.round(val)}`}>
                    <div
                      className="w-full aspect-square"
                      style={{
                        opacity: intensity,
                        backgroundColor: "var(--foreground)",
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [today, setToday] = useState<Reading[]>([]);
  const [heatmap, setHeatmap] = useState<HourlyAvg[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [s, t, h] = await Promise.all([
        api<Stats>("/api/stats"),
        api<Reading[]>("/api/today"),
        api<HourlyAvg[]>("/api/heatmap"),
      ]);
      if (s === null && t === null && h === null) {
        setError(true);
        return;
      }
      setError(false);
      if (s) setStats(s);
      if (t) setToday(t);
      if (h) setHeatmap(h);
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  const pct = stats && stats.capacity > 0 ? Math.round((stats.current / stats.capacity) * 100) : 0;

  return (
    <div className="p-8 max-w-4xl mx-auto flex flex-col gap-4 min-h-screen justify-center">
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
        <div className="flex gap-6 items-baseline">
          <div>
            <span className="text-2xl font-bold tabular-nums">{stats.current}</span>
            <span className="text-[var(--muted-foreground)]">/{stats.capacity}</span>
          </div>
          <div className="flex-1 h-2 bg-[var(--muted)]">
            <div
              className="h-full bg-[var(--foreground)] transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="tabular-nums font-medium">{pct}%</span>
        </div>
      )}

      <section>
        <h2 className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-2">
          Today
        </h2>
        <div className="h-40 w-full">
          {today.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={today}>
                <CartesianGrid strokeDasharray="2 2" stroke="var(--border)" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={formatTime}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  stroke="var(--border)"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  stroke="var(--border)"
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--background)",
                    border: "1px solid var(--border)",
                    borderRadius: 0,
                    fontSize: 11,
                    fontFamily: "inherit",
                  }}
                  labelFormatter={(label) => formatTime(String(label))}
                />
                <Area
                  type="stepAfter"
                  dataKey="count"
                  stroke="var(--foreground)"
                  fill="var(--muted)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-[var(--muted-foreground)]">
              no data yet
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider mb-2">
          Weekly Heatmap
        </h2>
        {heatmap.length > 0 ? (
          <Heatmap data={heatmap} />
        ) : (
          <div className="text-[var(--muted-foreground)]">collecting data...</div>
        )}
      </section>
    </div>
  );
}
