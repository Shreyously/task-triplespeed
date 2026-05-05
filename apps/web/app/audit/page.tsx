"use client";
import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "../../lib/config";

type AuditEvent = {
  id: number;
  purchase_id: string;
  created_at: string;
  event_hash: string;
  previous_event_hash: string | null;
  payload: {
    rarityWeightMicros?: Record<string, number>;
    drawnRarities?: string[];
    cardsPerPack?: number;
  };
};

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/provably-fair/audit-log?limit=200`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch(() => setMsg("Failed to load audit log"));
  }, []);

  const raritySummary = useMemo(() => {
    const observed: Record<string, number> = {};
    const expected: Record<string, number> = {};
    for (const event of events) {
      const weights = event.payload?.rarityWeightMicros ?? {};
      const drawn = event.payload?.drawnRarities ?? [];
      for (const rarity of drawn) {
        observed[rarity] = (observed[rarity] ?? 0) + 1;
      }
      const cardsPerPack = Number(event.payload?.cardsPerPack ?? drawn.length);
      for (const [rarity, micros] of Object.entries(weights)) {
        expected[rarity] = (expected[rarity] ?? 0) + (Number(micros) / 1_000_000) * cardsPerPack;
      }
    }
    return { observed, expected };
  }, [events]);

  return (
    <div className="page-stack">
      <h1 className="fluid-title">Public Fairness Audit</h1>
      {msg && <p className="text-rose-400">{msg}</p>}
      <div className="card">
        <p>Total openings logged: {events.length}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Object.keys({ ...raritySummary.observed, ...raritySummary.expected }).sort().map((rarity) => {
          const obs = raritySummary.observed[rarity] ?? 0;
          const exp = raritySummary.expected[rarity] ?? 0;
          const variance = Math.max(exp * (1 - Math.min(0.999, exp / Math.max(1, events.length * 10))), 1e-9);
          const z = exp > 0 ? (obs - exp) / Math.sqrt(variance) : 0;
          const status = exp < 30 ? "Low sample" : Math.abs(z) <= 3 ? "Within tolerance" : "Needs review";
          return (
          <div className="card" key={rarity}>
            <p className="font-semibold">{rarity}</p>
            <p>Observed: {obs.toFixed ? obs.toFixed(0) : obs}</p>
            <p>Expected: {exp.toFixed(2)}</p>
            <p>Z-score: {z.toFixed(2)}</p>
            <p>Status: {status}</p>
          </div>
          );
        })}
      </div>
      <div className="card">
        <h2 className="text-lg font-semibold">Recent Audit Events</h2>
        <div className="mt-3 space-y-3">
          {events.map((event) => (
            <div className="rounded border border-slate-700 p-3" key={event.id}>
              <p className="safe-break text-xs text-slate-400">{event.created_at}</p>
              <p className="safe-break text-sm">purchase: {event.purchase_id}</p>
              <p className="safe-break text-xs text-slate-400">hash: {event.event_hash}</p>
              <p className="safe-break text-xs text-slate-400">prev: {event.previous_event_hash ?? "genesis"}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
