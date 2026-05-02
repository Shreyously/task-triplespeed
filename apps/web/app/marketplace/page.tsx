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

export default function MarketplacePage() {
  const [listings, setListings] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [buyingListingId, setBuyingListingId] = useState("");
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
    fetch(`${API_BASE}/listings`).then((r) => r.json()).then((d) => setListings(d.listings || [])).catch(() => setMsg("Failed to load marketplace. Check API server.")).finally(() => setLoading(false));

    socket.on(SOCKET_EVENTS.LISTING_CREATED, (payload) => setListings((prev) => [payload, ...prev]));
    socket.on(SOCKET_EVENTS.LISTING_SOLD, (payload) => {
      setListings((prev) => prev.filter((l) => l.id !== payload.listingId));
      const token = localStorage.getItem("token") || "";
      if (!token) return;
      fetch(`${API_BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()).then((me) => {
        const userId = me?.user?.userId;
        if (!userId) return;
        if (payload.buyerId === userId) setMsg(`You bought ${payload.cardName} for $${payload.price}!`);
        else if (payload.sellerId === userId) setMsg(`Your ${payload.cardName} sold for $${payload.price}!`);
      });
    });

    socket.on(SOCKET_EVENTS.PRICE_CARD_UPDATED, (payload: any) => {
      if (payload.cards && Array.isArray(payload.cards)) {
        setListings((prev) => prev.map((listing) => {
          const update = payload.cards.find((u: any) => u.id === listing.card_id);
          if (update) return { ...listing, market_value: update.value };
          return listing;
        }));
      }
    });

    return () => { socket.disconnect(); };
  }, []);

  async function buy(id: string) {
    setBuyingListingId(id);
    const token = localStorage.getItem("token") || "";
    const key = uuid();
    const r = await fetch(`${API_BASE}/listings/${id}/buy`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key }, body: JSON.stringify({ idempotencyKey: key }) });
    const data = await r.json();
    setMsg(r.ok ? `Bought listing ${id}` : errorToMessage(data?.error, "Failed to buy listing"));
    setBuyingListingId("");
  }

  return (
    <div className="page-stack">
      <h1 className="fluid-title">Marketplace</h1>
      {msg && <p className="safe-break text-sm sm:text-base">{msg}</p>}
      {loading && <p>Loading listings...</p>}
      {!loading && listings.length === 0 && (
        <div className="card space-y-2">
          <p>No active listings yet.</p>
          <p className="text-sm text-slate-300">Go to your collection and list a card to populate the marketplace.</p>
          <Link href="/collection" className="touch-btn inline-flex bg-cyan-500 text-slate-900">Go to Collection</Link>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {listings.map((l) => {
          const vsMarket = Number(l.price) - Number(l.market_value);
          const gross = Number(l.price);
          const estimatedFee = (gross * FEES.TRADE_FEE_RATE).toFixed(2);
          return (
            <div key={l.id} className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-1 gap-3 sm:gap-4">
                {l.image_url && <img src={l.image_url} alt={l.card_name} className="safe-media h-24 w-24 shrink-0 rounded" />}
                <div className="min-w-0 flex-1">
                  <p className="safe-break font-semibold">{l.card_name || "Card"}</p>
                  <p className="safe-break text-sm text-slate-300">{l.set_name} - {l.rarity}</p>
                  <p className="text-sm">Market: ${l.market_value}</p>
                  <p className="text-lg font-semibold">List: ${l.price}</p>
                  <p className={`safe-break text-sm ${vsMarket > 0 ? "text-amber-400" : vsMarket < 0 ? "text-emerald-400" : "text-slate-400"}`}>{vsMarket > 0 ? `+$${vsMarket.toFixed(2)} above market` : vsMarket < 0 ? `-$${Math.abs(vsMarket).toFixed(2)} below market` : "At market price"}</p>
                  <p className="text-xs text-slate-400">Platform fee on sale: {(FEES.TRADE_FEE_RATE * 100).toFixed(0)}% (est. ${estimatedFee})</p>
                  <p className="safe-break text-xs text-slate-400">Seller: {l.seller_id?.slice(0, 8)}...</p>
                </div>
              </div>
              <div className="w-full sm:w-auto">
                {!isAuthenticated && (
                  <p className="mb-1 text-xs text-slate-400">Sign in to buy</p>
                )}
                <button
                  className="touch-btn w-full bg-cyan-500 text-slate-900 disabled:opacity-60 sm:w-auto"
                  onClick={() => buy(l.id)}
                  disabled={!isAuthenticated || buyingListingId === l.id}
                >
                  {buyingListingId === l.id ? "Buying..." : "Buy"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
