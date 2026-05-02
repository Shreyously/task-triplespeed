"use client";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, SOCKET_BASE, uuid } from "../lib/config";
import Link from "next/link";
import { SOCKET_EVENTS } from "@pullvault/common";

type Drop = { id: string; tier: string; price: string; inventory: number; starts_at: string; ends_at: string };
const RECENT_UNOPENED_PACK_IDS_KEY = "recent-unopened-pack-ids";
const TIER_ORDER: Record<string, number> = { BASIC: 0, PRO: 1, ELITE: 2 };

export default function HomePage() {
  const [drops, setDrops] = useState<Drop[]>([]);
  const [msg, setMsg] = useState("");
  const [serverTime, setServerTime] = useState<string>(new Date().toISOString());
  const [buyingDropId, setBuyingDropId] = useState<string>("");
  const [recentUnopenedPackIds, setRecentUnopenedPackIds] = useState<string[]>([]);
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
    const raw = localStorage.getItem(RECENT_UNOPENED_PACK_IDS_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setRecentUnopenedPackIds(parsed.filter((v) => typeof v === "string"));
      }
    } catch {
      setRecentUnopenedPackIds([]);
    }
  }, []);

  function addUnopenedPack(purchaseId: string) {
    setRecentUnopenedPackIds((prev) => {
      const next = [purchaseId, ...prev.filter((id) => id !== purchaseId)].slice(0, 8);
      localStorage.setItem(RECENT_UNOPENED_PACK_IDS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function markPackOpened(purchaseId: string) {
    setRecentUnopenedPackIds((prev) => {
      const next = prev.filter((id) => id !== purchaseId);
      localStorage.setItem(RECENT_UNOPENED_PACK_IDS_KEY, JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    const socket = io(SOCKET_BASE);
    fetch(`${API_BASE}/drops`).then((r) => r.json()).then((d) => {
      const rows = d.drops ?? [];
      setDrops(rows);
      setServerTime(d.serverTime ?? new Date().toISOString());
      rows.forEach((drop: Drop) => socket.emit("join:drop", drop.id));
    });
    socket.on(SOCKET_EVENTS.DROP_INVENTORY_UPDATED, (p) => {
      setDrops((prev) => prev.map((d) => d.id === p.dropId ? { ...d, inventory: p.inventory } : d));
    });
    socket.on(SOCKET_EVENTS.DROP_PRICE_UPDATED, (p) => {
      setDrops((prev) => prev.map((d) => d.id === p.dropId ? { ...d, price: p.price } : d));
    });
    socket.on(SOCKET_EVENTS.DROP_STATUS_UPDATED, (p) => {
      setDrops((prev) => prev.map((d) => d.id === p.dropId ? { ...d, starts_at: p.startsAt, ends_at: p.endsAt } : d));
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setServerTime((prev) => new Date(new Date(prev).getTime() + 1000).toISOString()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function buy(dropId: string) {
    setBuyingDropId(dropId);
    const token = localStorage.getItem("token") || "";
    const idem = uuid();
    const r = await fetch(`${API_BASE}/packs/buy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": idem
      },
      body: JSON.stringify({ dropId, idempotencyKey: idem })
    });
    const data = await r.json();
    if (r.ok) {
      setMsg(`Bought pack ${data.purchase.id}`);
      addUnopenedPack(data.purchase.id);
      setBuyingDropId("");
      return;
    }
    setMsg(data.error);
    setBuyingDropId("");
  }

  function getCountdown(startsAt: string, endsAt: string) {
    const nowTime = new Date(serverTime).getTime();
    const endDiffMs = new Date(endsAt).getTime() - nowTime;
    const startDiffMs = new Date(startsAt).getTime() - nowTime;

    if (endDiffMs <= 0) return "Closed";
    if (startDiffMs <= 0) return "Live now";

    const secs = Math.floor(startDiffMs / 1000);
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const remainingSecs = secs % 60;

    const hh = hrs > 0 ? `${String(hrs).padStart(2, "0")}:` : "";
    const mm = String(mins).padStart(2, "0");
    const ss = String(remainingSecs).padStart(2, "0");
    return `Starts in ${hh}${mm}:${ss}`;
  }

  function isDropClosed(endsAt: string) {
    return new Date(endsAt).getTime() <= new Date(serverTime).getTime();
  }

  function isDropNotStarted(startsAt: string) {
    return new Date(startsAt).getTime() > new Date(serverTime).getTime();
  }

  const orderedDrops = [...drops].sort((a, b) => {
    const aOrder = TIER_ORDER[a.tier.toUpperCase()] ?? Number.MAX_SAFE_INTEGER;
    const bOrder = TIER_ORDER[b.tier.toUpperCase()] ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.tier.localeCompare(b.tier);
  });

  return (
    <div className="page-stack">
      <h1 className="fluid-title">Pack Drops</h1>
      {msg && <p className="safe-break text-sm sm:text-base">{msg}</p>}
      {recentUnopenedPackIds.length > 0 && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Unopened Packs ({recentUnopenedPackIds.length})</h2>
            <Link
              className="touch-btn inline-flex bg-emerald-500 text-slate-900"
              href={`/reveal/${recentUnopenedPackIds[0]}`}
              onClick={() => markPackOpened(recentUnopenedPackIds[0])}
            >
              Reveal Next Pack
            </Link>
          </div>
          {recentUnopenedPackIds.length > 1 && (
            <details className="rounded border border-slate-700 bg-slate-800/40 p-3">
              <summary className="cursor-pointer text-sm text-slate-300">Choose a different pack</summary>
              <div className="mt-3 flex flex-wrap gap-2">
                {recentUnopenedPackIds.slice(1).map((purchaseId) => (
                  <Link
                    key={purchaseId}
                    href={`/reveal/${purchaseId}`}
                    onClick={() => markPackOpened(purchaseId)}
                    className="touch-btn bg-slate-200 text-slate-900"
                  >
                    {purchaseId.slice(0, 8)}...
                  </Link>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {orderedDrops.map((d) => {
          const closed = isDropClosed(d.ends_at);
          const notStarted = isDropNotStarted(d.starts_at);
          return (
            <div key={d.id} className="card space-y-2">
              <h2 className="text-lg sm:text-xl">{d.tier}</h2>
              <p>Price: ${d.price}</p>
              <p>Inventory: {d.inventory}</p>
              <p className="safe-break">Drop: {getCountdown(d.starts_at, d.ends_at)}</p>
              <button
                className="touch-btn w-full bg-cyan-500 text-slate-900 disabled:opacity-50 sm:w-auto"
                onClick={() => buy(d.id)}
                disabled={!isAuthenticated || d.inventory <= 0 || closed || notStarted || buyingDropId === d.id}
              >
                {buyingDropId === d.id ? "Buying..." : closed ? "Closed" : notStarted ? "Upcoming" : d.inventory <= 0 ? "Sold Out" : "Buy Pack"}
              </button>
              {!isAuthenticated && <p className="text-xs text-slate-400">Sign in to buy packs</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
