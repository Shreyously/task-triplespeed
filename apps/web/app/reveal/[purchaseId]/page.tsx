"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "../../../lib/config";

type Card = { id: string; name: string; set_name: string; rarity: string; image_url: string; market_value: string };
const RECENT_UNOPENED_PACK_IDS_KEY = "recent-unopened-pack-ids";

export default function RevealPage({ params }: { params: { purchaseId: string } }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [totalValue, setTotalValue] = useState("0.00");
  const [pnl, setPnl] = useState("0.00");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const raw = localStorage.getItem(RECENT_UNOPENED_PACK_IDS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          localStorage.setItem(
            RECENT_UNOPENED_PACK_IDS_KEY,
            JSON.stringify(parsed.filter((id) => typeof id === "string" && id !== params.purchaseId))
          );
        }
      } catch {
        // Ignore malformed local storage data
      }
    }

    const token = localStorage.getItem("token") || "";
    fetch(`${API_BASE}/packs/${params.purchaseId}/reveal`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setMsg(data.error);
          return;
        }
        setCards(data.cards ?? []);
        setTotalValue(data.totalValue ?? "0.00");
        setPnl(data.pnl ?? "0.00");
      });
  }, [params.purchaseId]);

  const current = cards[index];
  return (
    <div className="page-stack">
      <h1 className="fluid-title">Pack Reveal</h1>
      {msg && <p className="safe-break text-sm sm:text-base">{msg}</p>}
      {!cards.length ? <p>Loading reveal...</p> : (
        <>
          <div key={`${current.id}-${index}`} className="card reveal-card-enter space-y-2">
            <p className="text-sm text-slate-400">Reveal {index + 1} / {cards.length}</p>
            <img src={current.image_url} alt={current.name} className="safe-media mx-auto h-48 w-48 rounded sm:h-56 sm:w-56" />
            <h2 className="safe-break text-xl font-semibold sm:text-2xl">{current.name}</h2>
            <p className="safe-break">{current.set_name}</p>
            <p>{current.rarity}</p>
            <p className="text-lg font-semibold">${current.market_value}</p>
          </div>
          <button className="touch-btn w-full bg-cyan-500 text-slate-900 disabled:opacity-50 sm:w-auto" onClick={() => setIndex((prev) => prev + 1)} disabled={index >= cards.length - 1}>
            {index >= cards.length - 1 ? "All cards revealed" : "Reveal next card"}
          </button>
          {index >= cards.length - 1 && (
            <div className="card reveal-summary-enter">
              <p>Total pack value: ${totalValue}</p>
              <p className={Number(pnl) >= 0 ? "text-emerald-400" : "text-rose-400"}>P/L: ${pnl}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
