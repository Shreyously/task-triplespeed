"use client";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, SOCKET_BASE, uuid } from "../../lib/config";
import { SOCKET_EVENTS } from "@pullvault/common";
import { FEES } from "@pullvault/common";
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
  const [biddingAuctionId, setBiddingAuctionId] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const checkAuth = () => setIsAuthenticated(!!localStorage.getItem("token"));
    checkAuth();
    window.addEventListener("storage", checkAuth);
    window.addEventListener("auth-change", checkAuth);
    return () => {
      window.removeEventListener("storage", checkAuth);
      window.removeEventListener("auth-change", checkAuth);
    };
  }, []);

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
        return prev.map((a) => a.id === p.auctionId ? { ...a, current_bid: p.highestBid, end_time: p.endTime, status: p.status, bidding_mode: p.biddingMode ?? a.bidding_mode } : a);
      });
      setSelected((prev: any) => prev && prev.auction?.id === p.auctionId ? { ...prev, auction: { ...prev.auction, current_bid: p.highestBid, end_time: p.endTime, status: p.status, bidding_mode: p.biddingMode ?? prev.auction.bidding_mode }, minimumBid: p.minimumBid ?? prev.minimumBid } : prev);
      setSyncedAt(new Date().toLocaleTimeString());
    });
    socket.on(SOCKET_EVENTS.AUCTION_SEALED_STATUS, (payload: any) => {
      setAuctions((prev) => prev.map((a) => a.id === payload.auctionId ? { ...a, status: payload.status, bidding_mode: payload.biddingMode, end_time: payload.endTime ?? a.end_time } : a));
      setSelected((prev: any) => prev && prev.auction?.id === payload.auctionId ? { ...prev, auction: { ...prev.auction, status: payload.status, bidding_mode: payload.biddingMode, end_time: payload.endTime ?? prev.auction.end_time } } : prev);
      setSyncedAt(new Date().toLocaleTimeString());
    });
    socket.on(SOCKET_EVENTS.AUCTION_BID_HISTORY, (payload) => setSelected((prev: any) => prev && prev.auction?.id === payload.auctionId ? { ...prev, bidHistory: payload.bids } : prev));
    socket.on(SOCKET_EVENTS.AUCTION_WATCHERS_UPDATED, (payload) => setSelected((prev: any) => prev && prev.auction?.id === payload.auctionId ? { ...prev, watcherCount: payload.watchers } : prev));
    socket.on(SOCKET_EVENTS.AUCTION_CLOSED, (payload) => {
      setAuctions((prev) => prev.map((a) => a.id === payload.auctionId ? { ...a, status: payload.status } : a));
      setSelected((prev: any) => prev?.auction?.id === payload.auctionId ? { ...prev, auction: { ...prev.auction, status: payload.status }, settlement: payload.settlement } : prev);
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
          if (update) return { ...a, market_value: update.value };
          return a;
        }));
        setSelected((prev: any) => {
          if (prev?.auction) {
            const update = payload.cards.find((u: any) => u.id === prev.auction.card_id);
            if (update) return { ...prev, auction: { ...prev.auction, market_value: update.value } };
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
    setBiddingAuctionId(id);
    const amount = (bidInput[id] || current).toString();
    const token = localStorage.getItem("token") || "";
    let key = uuid();
    let r = await fetch(`${API_BASE}/auctions/${id}/bids`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key }, body: JSON.stringify({ amount, idempotencyKey: key }) });
    const data = await r.json();
    if (r.status === 409 && data?.confirmationRequired) {
      const confirmed = window.confirm(`${data.message}. Confirm ${data.mode === "SEALED" ? "sealed max bid" : "bid"} of $${amount}?`);
      if (confirmed) {
        key = uuid();
        r = await fetch(`${API_BASE}/auctions/${id}/bids`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key }, body: JSON.stringify({ amount, idempotencyKey: key, confirmHighBid: true }) });
        const confirmedData = await r.json();
        setMsg(r.ok ? (confirmedData.mode === "SEALED" ? `Hidden max bid saved at $${amount}` : `Bid placed at $${amount}`) : errorToMessage(confirmedData?.error, "Failed to place bid"));
      } else {
        setMsg("High bid cancelled.");
      }
    } else {
      setMsg(r.ok ? (data.mode === "SEALED" ? `Hidden max bid saved at $${amount}` : `Bid placed at $${amount}`) : errorToMessage(data?.error, "Failed to place bid"));
    }
    if (r.ok) await openRoom(id);
    setBiddingAuctionId("");
  }

  async function openRoom(id: string) {
    if (selected?.auction?.id === id) {
      setSelected(null);
      return;
    }
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${API_BASE}/auctions/${id}/snapshot`, { headers: { authorization: `Bearer ${token}` } });
    const data = await res.json();
    setSelected(data);
    setCountdown(data.timeLeftSeconds ?? 0);
    setSyncedAt(new Date().toLocaleTimeString());
    if (data.minimumBid) setBidInput((prev) => ({ ...prev, [id]: data.minimumBid }));
  }

  function statusClass(status: string) {
    if (status === "LIVE") return "bg-emerald-500 text-slate-950";
    if (status === "CLOSING") return "bg-amber-400 text-slate-950";
    if (status === "SEALED_ENDGAME") return "bg-fuchsia-500 text-white";
    if (status === "CLOSED") return "bg-rose-500 text-white";
    if (status === "SETTLED") return "bg-cyan-500 text-slate-950";
    return "bg-slate-500 text-white";
  }

  return (
    <div className="page-stack">
      <h1 className="fluid-title">Live Auctions</h1>
      {msg && <p className="safe-break text-sm sm:text-base">{msg}</p>}
      {loading && <p>Loading auctions...</p>}
      {!loading && auctions.length === 0 && <div className="card space-y-2"><p>No live auctions right now.</p><p className="text-sm text-slate-300">Start one from your collection to make this room active.</p><Link href="/collection" className="touch-btn inline-flex bg-cyan-500 text-slate-900">Go to Collection</Link></div>}
      <div className="grid gap-4 md:grid-cols-2">
        {auctions.map((a) => (
          <div className="card space-y-2" key={a.id}>
            <div className={`inline-block rounded px-2 py-1 text-xs font-semibold ${statusClass(a.status)}`}>{a.status}</div>
            {a.image_url && <img src={a.image_url} alt={a.card_name} className="safe-media h-32 w-32 rounded" />}
            <p className="safe-break font-semibold">{a.card_name ?? "Card"}</p>
            <p className="safe-break text-sm text-slate-300">{a.set_name} - {a.rarity}</p>
            <p className="text-sm">Market: ${a.market_value}</p>
            <p className="safe-break text-sm">Auction: {a.id}</p>
            <p>{a.bidding_mode === "SEALED" ? "Visible floor" : "Current bid"}: ${a.current_bid}</p>
            <p>Ends: {new Date(a.end_time).toLocaleTimeString()}</p>
            <p className="text-xs text-slate-400">Mode: {a.bidding_mode === "SEALED" ? "Sealed endgame" : "Open bidding"}</p>
            <p className="text-xs text-slate-400">
              Platform fee on successful sale: {(FEES.AUCTION_FEE_RATE * 100).toFixed(0)}%
            </p>
            <div className="flex flex-wrap gap-2">
              <input className="touch-input w-full sm:w-36" value={bidInput[a.id] ?? ""} onChange={(e) => setBidInput((prev) => ({ ...prev, [a.id]: e.target.value }))} />
              <button className="touch-btn w-full bg-cyan-500 text-slate-900 disabled:opacity-60 sm:w-auto" onClick={() => bid(a.id, a.current_bid)} disabled={!isAuthenticated || biddingAuctionId === a.id}>
                {biddingAuctionId === a.id ? "Bidding..." : "Place Bid"}
              </button>
            </div>
            {!isAuthenticated && <p className="text-xs text-slate-400">Sign in to bid</p>}
            <button className="touch-btn w-full bg-slate-200 text-slate-900 sm:w-auto" onClick={() => openRoom(a.id)}>
              {selected?.auction?.id === a.id ? "Close Room" : "Open Room"}
            </button>
          </div>
        ))}
      </div>
      {selected?.auction && (
        <div className="card space-y-2">
          <h2 className="text-xl font-semibold">Auction Room</h2>
          <div className={`inline-block rounded px-2 py-1 text-xs font-semibold ${statusClass(selected.auction.status)}`}>{selected.auction.status}</div>
          <p className="text-sm text-slate-300">Synced at: {syncedAt || "-"}</p>
          {selected.auction.image_url && <img src={selected.auction.image_url} alt={selected.auction.card_name} className="safe-media h-40 w-40 rounded" />}
          <p className="safe-break font-semibold">{selected.auction.card_name}</p>
          <p className="safe-break text-sm text-slate-300">{selected.auction.set_name} - {selected.auction.rarity}</p>
          <p className="text-sm text-slate-300">
            {selected.auction.bidding_mode === "SEALED"
              ? "Sealed endgame is active. Other bidders' max bids are hidden until settlement."
              : "Open ascending bidding is active."}
          </p>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p className="safe-break rounded bg-slate-800/60 px-3 py-2">Market: ${selected.auction.market_value}</p>
            <p className="safe-break rounded bg-slate-800/60 px-3 py-2">Server countdown: {countdown}s</p>
            <p className="safe-break rounded bg-slate-800/60 px-3 py-2">Minimum valid bid: ${selected.minimumBid ?? "1.00"}</p>
            <p className="safe-break rounded bg-slate-800/60 px-3 py-2">Watchers: {selected.watcherCount ?? 0}</p>
            <p className="safe-break rounded bg-slate-800/60 px-3 py-2 sm:col-span-2">Your held funds: ${selected.yourHeld}</p>
            <p className="safe-break rounded bg-slate-800/60 px-3 py-2 sm:col-span-2">Your sealed max: {selected.yourSealedMaxBid ? `$${selected.yourSealedMaxBid}` : "Not set"}</p>
            <p className="safe-break rounded bg-slate-800/60 px-3 py-2 sm:col-span-2">Platform fee on sale: {(FEES.AUCTION_FEE_RATE * 100).toFixed(0)}%</p>
          </div>
          <h3 className="font-medium">Bid History</h3>
          {selected.auction.bidding_mode === "SEALED" ? (
            <p className="text-sm text-slate-400">Open bid history is shown below, but sealed max bids remain hidden until the auction settles.</p>
          ) : null}
          <ul className="space-y-1 text-sm">
            {(selected.bidHistory ?? []).map((b: any) => <li key={b.id} className="safe-break">{new Date(b.created_at).toLocaleTimeString()} - ${b.amount} by {b.bidder_id.slice(0, 8)}...</li>)}
          </ul>
          {selected.settlement && (
            <div className="rounded border border-slate-700 bg-slate-900 p-3">
              <p className="font-semibold">Final Settlement</p>
              <p className="safe-break">Winner: {selected.settlement.winner_id ? `${selected.settlement.winner_id.slice(0, 8)}...` : "No bids"}</p>
              <p>Final Price: ${selected.settlement.gross_amount ?? "0.00"}</p>
              <p>Winning Max: ${selected.settlement.winning_max_bid ?? "0.00"}</p>
              <p>Clearing Price: ${selected.settlement.final_clearing_price ?? selected.settlement.gross_amount ?? "0.00"}</p>
              <p>Platform Fee: ${selected.settlement.fee_amount ?? "0.00"}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
