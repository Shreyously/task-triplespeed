"use client";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, SOCKET_BASE, uuid } from "../lib/config";
import Link from "next/link";
import { SOCKET_EVENTS } from "@pullvault/common";

type Drop = { id: string; tier: string; price: string; inventory: number; starts_at: string; ends_at: string };

export default function HomePage() {
  const [drops, setDrops] = useState<Drop[]>([]);
  const [msg, setMsg] = useState("");
  const [serverTime, setServerTime] = useState<string>(new Date().toISOString());
  const [lastPurchaseId, setLastPurchaseId] = useState<string>("");

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
      setLastPurchaseId(data.purchase.id);
      setMsg(`Bought pack ${data.purchase.id}`);
      return;
    }
    setMsg(data.error);
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

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Pack Drops</h1>
      {msg && <p>{msg}</p>}
      {lastPurchaseId && (
        <Link className="inline-block rounded bg-emerald-500 px-4 py-2 font-medium text-slate-900" href={`/reveal/${lastPurchaseId}`}>
          Reveal Last Pack
        </Link>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {drops.map((d) => {
          const closed = isDropClosed(d.ends_at);
          const notStarted = isDropNotStarted(d.starts_at);
          return (
            <div key={d.id} className="card space-y-2">
              <h2 className="text-xl">{d.tier}</h2>
              <p>Price: ${d.price}</p>
              <p>Inventory: {d.inventory}</p>
              <p>Drop: {getCountdown(d.starts_at, d.ends_at)}</p>
              <button
                className="rounded bg-cyan-500 px-3 py-2 text-slate-900 disabled:opacity-50"
                onClick={() => buy(d.id)}
                disabled={d.inventory <= 0 || closed || notStarted}
              >
                {closed ? "Closed" : notStarted ? "Upcoming" : d.inventory <= 0 ? "Sold Out" : "Buy Pack"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
