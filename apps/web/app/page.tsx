"use client";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, SOCKET_BASE, uuid } from "../lib/config";
import Link from "next/link";
import { SOCKET_EVENTS } from "@pullvault/common";

type Drop = { id: string; tier: string; price: string; inventory: number; starts_at: string };

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

  function getCountdown(startsAt: string) {
    const diffMs = new Date(startsAt).getTime() - new Date(serverTime).getTime();
    if (diffMs <= 0) return "Live now";
    const secs = Math.floor(diffMs / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    return `${mm}:${ss}`;
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
        {drops.map((d) => (
          <div key={d.id} className="card space-y-2">
            <h2 className="text-xl">{d.tier}</h2>
            <p>Price: ${d.price}</p>
            <p>Inventory: {d.inventory}</p>
            <p>Drop: {getCountdown(d.starts_at)}</p>
            <button className="rounded bg-cyan-500 px-3 py-2 text-slate-900 disabled:opacity-50" onClick={() => buy(d.id)} disabled={d.inventory <= 0}>
              {d.inventory <= 0 ? "Sold Out" : "Buy Pack"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
