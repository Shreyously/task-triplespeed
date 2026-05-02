"use client";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, SOCKET_BASE, uuid } from "../../lib/config";
import { SOCKET_EVENTS } from "@pullvault/common";
import Link from "next/link";

function errorToMessage(error: unknown, fallback = "Something went wrong") {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return fallback;

  const maybe = error as { formErrors?: unknown; fieldErrors?: Record<string, unknown> };
  const form = Array.isArray(maybe.formErrors) ? maybe.formErrors.find((v) => typeof v === "string") : undefined;
  if (typeof form === "string" && form) return form;

  if (maybe.fieldErrors && typeof maybe.fieldErrors === "object") {
    for (const value of Object.values(maybe.fieldErrors)) {
      if (Array.isArray(value)) {
        const first = value.find((v) => typeof v === "string");
        if (typeof first === "string" && first) return first;
      }
    }
  }

  return fallback;
}

export default function AuctionsPage() {
  const [auctions, setAuctions] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(true);
  const [bidInput, setBidInput] = useState<Record<string, string>>({});
  const [syncedAt, setSyncedAt] = useState("");

  useEffect(() => {
    if (!msg) return;
    const timer = setTimeout(() => setMsg(""), 5000);
    return () => clearTimeout(timer);
  }, [msg]);

  useEffect(() => {
    const socket = io(SOCKET_BASE);
    async function refreshLiveAuctions(showLoading = false) {
      if (showLoading) setLoading(true);
      try {
        const r = await fetch(`${API_BASE}/auctions/live`);
        const d = await r.json();
        const rows = d.auctions || [];
        setAuctions(rows);
        const seed: Record<string, string> = {};
        rows.forEach((a: any) => {
          const current = Number(a.current_bid);
          seed[a.id] = (current === 0 ? 1 : Math.max(current + 1, current * 1.05)).toFixed(2);
          socket.emit(SOCKET_EVENTS.JOIN_AUCTION, a.id);
        });
        setBidInput(seed);
      } catch {
        setMsg("Failed to load auctions. Check API server.");
      } finally {
        if (showLoading) setLoading(false);
      }
    }

    refreshLiveAuctions(true);

    socket.on(SOCKET_EVENTS.AUCTION_UPDATED, (p) => {
      setAuctions((prev) => {
        const exists = prev.some((a) => a.id === p.auctionId);
        if (!exists && p.status === "ACTIVE") {
          refreshLiveAuctions(false);
          return prev;
        }
        return prev.map((a) => a.id === p.auctionId ? { ...a, current_bid: p.highestBid, end_time: p.endTime } : a);
      });
      setSelected((prev: any) => prev && prev.auction?.id === p.auctionId ? { ...prev, auction: { ...prev.auction, current_bid: p.highestBid, end_time: p.endTime } } : prev);
      setSyncedAt(new Date().toLocaleTimeString());
    });
    socket.on(SOCKET_EVENTS.AUCTION_BID_HISTORY, (payload) => {
      setSelected((prev: any) => prev && prev.auction?.id === payload.auctionId ? { ...prev, bidHistory: payload.bids } : prev);
    });
    socket.on(SOCKET_EVENTS.AUCTION_WATCHERS_UPDATED, (payload) => {
      setSelected((prev: any) => prev && prev.auction?.id === payload.auctionId ? { ...prev, watcherCount: payload.watchers } : prev);
    });
    socket.on(SOCKET_EVENTS.AUCTION_CLOSED, (payload) => {
      setAuctions((prev) => prev.map((a) => a.id === payload.auctionId ? { ...a, status: payload.status } : a));
      setSelected((prev: any) => {
        if (prev?.auction?.id === payload.auctionId) {
          return {
            ...prev,
            auction: { ...prev.auction, status: payload.status },
            settlement: payload.settlement
          };
        }
        return prev;
      });
      setMsg(`Auction ${payload.auctionId.slice(0, 8)}... ended! ${payload.settlement?.winner_id ? `Sold for $${payload.settlement.gross_amount}` : "No bids - card returned to seller"}`);

      setTimeout(() => {
        setAuctions((prev) => prev.filter((a) => a.id !== payload.auctionId));
        setSelected((prev: any) => prev?.auction?.id === payload.auctionId ? null : prev);
      }, 5000);
    });
    socket.on(SOCKET_EVENTS.PRICE_CARD_UPDATED, (payload: any) => {
      if (payload.cards && Array.isArray(payload.cards)) {
        setAuctions((prev) => prev.map((a) => {
          const update = payload.cards.find((u: any) => u.id === a.card_id);
          if (update) {
            return { ...a, market_value: update.value };
          }
          return a;
        }));
        setSelected((prev: any) => {
          if (prev?.auction) {
            const update = payload.cards.find((u: any) => u.id === prev.auction.card_id);
            if (update) {
              return { ...prev, auction: { ...prev.auction, market_value: update.value } };
            }
          }
          return prev;
        });
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!selected?.auction?.end_time) return;
      setCountdown(Math.max(0, Math.floor((new Date(selected.auction.end_time).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [selected]);

  async function bid(id: string, current: string) {
    const amount = (bidInput[id] || current).toString();
    const token = localStorage.getItem("token") || "";
    const key = uuid();
    const r = await fetch(`${API_BASE}/auctions/${id}/bids`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": key
      },
      body: JSON.stringify({ amount, idempotencyKey: key })
    });
    const data = await r.json();
    setMsg(r.ok ? `Bid placed at $${amount}` : errorToMessage(data?.error, "Failed to place bid"));
    if (r.ok) {
      await openRoom(id);
    }
  }

  async function openRoom(id: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${API_BASE}/auctions/${id}/snapshot`, { headers: { authorization: `Bearer ${token}` } });
    const data = await res.json();
    setSelected(data);
    setCountdown(data.timeLeftSeconds ?? 0);
    setSyncedAt(new Date().toLocaleTimeString());
    if (data.minimumBid) {
      setBidInput((prev) => ({ ...prev, [id]: data.minimumBid }));
    }
  }

  function statusClass(status: string) {
    if (status === "LIVE") return "bg-emerald-500 text-slate-950";
    if (status === "CLOSING") return "bg-amber-400 text-slate-950";
    if (status === "CLOSED") return "bg-rose-500 text-white";
    if (status === "SETTLED") return "bg-cyan-500 text-slate-950";
    return "bg-slate-500 text-white";
  }

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Live Auctions</h1>
      {msg && <p>{msg}</p>}
      {loading && <p>Loading auctions...</p>}
      {!loading && auctions.length === 0 && (
        <div className="card space-y-2">
          <p>No live auctions right now.</p>
          <p className="text-sm text-slate-300">Start one from your collection to make this room active.</p>
          <Link href="/collection" className="inline-block rounded bg-cyan-500 px-3 py-2 text-slate-900">
            Go to Collection
          </Link>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
      {auctions.map((a) => (
        <div className="card space-y-2" key={a.id}>
          <div className={`inline-block rounded px-2 py-1 text-xs font-semibold ${statusClass(a.status)}`}>{a.status}</div>
          {a.image_url && <img src={a.image_url} alt={a.card_name} className="h-32 rounded object-contain" />}
          <p className="font-semibold">{a.card_name ?? "Card"}</p>
          <p className="text-sm text-slate-300">{a.set_name} - {a.rarity}</p>
          <p className="text-sm">Market: ${a.market_value}</p>
          <p>Auction: {a.id}</p>
          <p>Current bid: ${a.current_bid}</p>
          <p>Ends: {new Date(a.end_time).toLocaleTimeString()}</p>
          <div className="flex gap-2">
            <input
              className="w-32 rounded bg-slate-800 px-2 py-2"
              value={bidInput[a.id] ?? ""}
              onChange={(e) => setBidInput((prev) => ({ ...prev, [a.id]: e.target.value }))}
            />
            <button className="rounded bg-cyan-500 px-3 py-2 text-slate-900" onClick={() => bid(a.id, a.current_bid)}>Place Bid</button>
          </div>
          <button className="rounded bg-slate-200 px-3 py-2 text-slate-900" onClick={() => openRoom(a.id)}>Open Room</button>
        </div>
      ))}
      </div>
      {selected?.auction && (
        <div className="card space-y-2">
          <h2 className="text-xl font-semibold">Auction Room</h2>
          <div className={`inline-block rounded px-2 py-1 text-xs font-semibold ${statusClass(selected.auction.status)}`}>{selected.auction.status}</div>
          <p className="text-sm text-slate-300">Synced at: {syncedAt || "-"}</p>
          {selected.auction.image_url && <img src={selected.auction.image_url} alt={selected.auction.card_name} className="h-40 rounded object-contain" />}
          <p className="font-semibold">{selected.auction.card_name}</p>
          <p className="text-sm text-slate-300">{selected.auction.set_name} - {selected.auction.rarity}</p>
          <p className="text-sm">Market: ${selected.auction.market_value}</p>
          <p>Server countdown: {countdown}s</p>
          <p>Minimum valid bid: ${selected.minimumBid ?? "1.00"}</p>
          <p>Watchers: {selected.watcherCount ?? 0}</p>
          <p>Your held funds: ${selected.yourHeld}</p>
          <h3 className="font-medium">Bid History</h3>
          <ul className="space-y-1 text-sm">
            {(selected.bidHistory ?? []).map((b: any) => (
              <li key={b.id}>{new Date(b.created_at).toLocaleTimeString()} - ${b.amount} by {b.bidder_id.slice(0, 8)}...</li>
            ))}
          </ul>
          {selected.settlement && (
            <div className="rounded border border-slate-700 bg-slate-900 p-3">
              <p className="font-semibold">Final Settlement</p>
              <p>Winner: {selected.settlement.winner_id ? `${selected.settlement.winner_id.slice(0, 8)}...` : "No bids"}</p>
              <p>Final Price: ${selected.settlement.gross_amount ?? "0.00"}</p>
              <p>Platform Fee: ${selected.settlement.fee_amount ?? "0.00"}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
