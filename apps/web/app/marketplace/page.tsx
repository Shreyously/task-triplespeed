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

export default function MarketplacePage() {
  const [listings, setListings] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!msg) return;
    const timer = setTimeout(() => setMsg(""), 5000);
    return () => clearTimeout(timer);
  }, [msg]);

  useEffect(() => {
    const socket = io(SOCKET_BASE);
    fetch(`${API_BASE}/listings`)
      .then((r) => r.json())
      .then((d) => setListings(d.listings || []))
      .catch(() => setMsg("Failed to load marketplace. Check API server."))
      .finally(() => setLoading(false));

    socket.on(SOCKET_EVENTS.LISTING_CREATED, (payload) => {
      setListings((prev) => [payload, ...prev]);
    });

    socket.on(SOCKET_EVENTS.LISTING_SOLD, (payload) => {
      setListings((prev) => prev.filter((l) => l.id !== payload.listingId));

      const token = localStorage.getItem("token") || "";
      if (!token) return;

      fetch(`${API_BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((me) => {
          const userId = me?.user?.userId;
          if (!userId) return;

          if (payload.buyerId === userId) {
            setMsg(`✅ You bought ${payload.cardName} for $${payload.price}!`);
          } else if (payload.sellerId === userId) {
            setMsg(`💰 Your ${payload.cardName} sold for $${payload.price}!`);
          }
        });
    });

    socket.on(SOCKET_EVENTS.PRICE_CARD_UPDATED, (payload: any) => {
      if (payload.cards && Array.isArray(payload.cards)) {
        setListings((prev) => prev.map((listing) => {
          const update = payload.cards.find((u: any) => u.id === listing.card_id);
          if (update) {
            return { ...listing, market_value: update.value };
          }
          return listing;
        }));
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  async function buy(id: string) {
    const token = localStorage.getItem("token") || "";
    const key = uuid();
    const r = await fetch(`${API_BASE}/listings/${id}/buy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": key
      },
      body: JSON.stringify({ idempotencyKey: key })
    });
    const data = await r.json();
    setMsg(r.ok ? `Bought listing ${id}` : errorToMessage(data?.error, "Failed to buy listing"));
  }

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Marketplace</h1>
      {msg && <p>{msg}</p>}
      {loading && <p>Loading listings...</p>}
      {!loading && listings.length === 0 && (
        <div className="card space-y-2">
          <p>No active listings yet.</p>
          <p className="text-sm text-slate-300">Go to your collection and list a card to populate the marketplace.</p>
          <Link href="/collection" className="inline-block rounded bg-cyan-500 px-3 py-2 text-slate-900">
            Go to Collection
          </Link>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {listings.map((l) => {
          const vsMarket = Number(l.price) - Number(l.market_value);
          return (
            <div key={l.id} className="card flex items-center justify-between gap-4">
              <div className="flex items-center gap-4 flex-1">
                {l.image_url && <img src={l.image_url} alt={l.card_name} className="h-24 rounded object-contain" />}
                <div className="flex-1">
                  <p className="font-semibold">{l.card_name || "Card"}</p>
                  <p className="text-sm text-slate-300">{l.set_name} - {l.rarity}</p>
                  <p className="text-sm">Market: ${l.market_value}</p>
                  <p className="text-lg font-semibold">List: ${l.price}</p>
                  <p className={`text-sm ${vsMarket > 0 ? "text-amber-400" : vsMarket < 0 ? "text-emerald-400" : "text-slate-400"}`}>
                    {vsMarket > 0 ? `+$${vsMarket.toFixed(2)} above market` : vsMarket < 0 ? `-$${Math.abs(vsMarket).toFixed(2)} below market` : "At market price"}
                  </p>
                  <p className="text-xs text-slate-400">Seller: {l.seller_id?.slice(0, 8)}...</p>
                </div>
              </div>
              <button className="rounded bg-cyan-500 px-4 py-2 text-slate-900 font-medium" onClick={() => buy(l.id)}>Buy</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
