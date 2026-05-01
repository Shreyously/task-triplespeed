"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "../../../lib/config";

type Card = { id: string; name: string; set_name: string; rarity: string; image_url: string; market_value: string };

export default function RevealPage({ params }: { params: { purchaseId: string } }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [totalValue, setTotalValue] = useState("0.00");
  const [pnl, setPnl] = useState("0.00");
  const [msg, setMsg] = useState("");

  useEffect(() => {
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
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Pack Reveal</h1>
      {msg && <p>{msg}</p>}
      {!cards.length ? <p>Loading reveal...</p> : (
        <>
          <div className="card space-y-2">
            <p className="text-sm text-slate-400">Reveal {index + 1} / {cards.length}</p>
            <img src={current.image_url} alt={current.name} className="h-56 rounded object-contain" />
            <h2 className="text-2xl font-semibold">{current.name}</h2>
            <p>{current.set_name}</p>
            <p>{current.rarity}</p>
            <p className="text-lg font-semibold">${current.market_value}</p>
          </div>
          <button
            className="rounded bg-cyan-500 px-3 py-2 text-slate-900 disabled:opacity-50"
            onClick={() => setIndex((prev) => prev + 1)}
            disabled={index >= cards.length - 1}
          >
            {index >= cards.length - 1 ? "All cards revealed" : "Reveal next card"}
          </button>
          {index >= cards.length - 1 && (
            <div className="card">
              <p>Total pack value: ${totalValue}</p>
              <p className={Number(pnl) >= 0 ? "text-emerald-400" : "text-rose-400"}>P/L: ${pnl}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
