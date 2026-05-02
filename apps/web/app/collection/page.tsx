"use client";
import { useEffect, useState, useMemo } from "react";
import { io } from "socket.io-client";
import { API_BASE, SOCKET_BASE, uuid } from "../../lib/config";
import { SOCKET_EVENTS } from "@pullvault/common";
import { FEES } from "@pullvault/common";
import Link from "next/link";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { SortConfig, FilterConfig, SortField, CollectionCard } from "../../lib/collectionTypes";
import { useCollectionSort } from "../../lib/hooks/useCollectionSort";
import { useCollectionFilter } from "../../lib/hooks/useCollectionFilter";
import { useCollectionPersistence } from "../../lib/hooks/useCollectionPersistence";
import { SortControls } from "../../components/collection/SortControls";
import { FilterControls } from "../../components/collection/FilterControls";

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
type HistoryPoint = { value: string; at: string };

export default function CollectionPage() {
  const [cards, setCards] = useState<CollectionCard[]>([]);
  const [summary, setSummary] = useState({ cardsValue: "0.00", availableBalance: "0.00", heldBalance: "0.00", netWorth: "0.00" });
  const [msg, setMsg] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [listingPrice, setListingPrice] = useState<Record<string, string>>({});
  const [sortConfig, setSortConfig] = useState<SortConfig>({ field: "created_at", direction: "desc" });
  const [filterConfig, setFilterConfig] = useState<FilterConfig>({ rarities: [], sets: [], valueRange: null });
  const [listingCardId, setListingCardId] = useState("");
  const [auctioningCardId, setAuctioningCardId] = useState("");
  const [auctionDurationByCard, setAuctionDurationByCard] = useState<Record<string, string>>({});
  const [selectedCard, setSelectedCard] = useState<CollectionCard | null>(null);
  const [historyRange, setHistoryRange] = useState<"24h" | "7d" | "30d">("24h");
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  useCollectionPersistence(sortConfig, filterConfig, setSortConfig, setFilterConfig);

  useEffect(() => {
    if (!msg) return;
    const timer = setTimeout(() => setMsg(""), 5000);
    return () => clearTimeout(timer);
  }, [msg]);

  useEffect(() => {
    let active = true;
    const fetchHistory = async () => {
      const token = localStorage.getItem("token") || "";
      if (!token) return;
      try {
        const res = await fetch(`${API_BASE}/portfolio/history?range=${historyRange}`, { headers: { authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (active) setHistory(data.points ?? []);
      } catch {
        if (active) setHistory([]);
      }
    };
    fetchHistory();
    const timer = setInterval(fetchHistory, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [historyRange]);

  useEffect(() => {
    let socket: ReturnType<typeof io> | null = null;
    (async () => {
      const token = localStorage.getItem("token") || "";
      if (!token) {
        setNeedsLogin(true);
        setMsg("Please login first to view your collection.");
        return;
      }
      const [cardsRes, summaryRes, meRes] = await Promise.all([
        fetch(`${API_BASE}/collection`, { headers: { authorization: `Bearer ${token}` } }),
        fetch(`${API_BASE}/portfolio/summary`, { headers: { authorization: `Bearer ${token}` } }),
        fetch(`${API_BASE}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
      ]);
      if (cardsRes.status === 401 || summaryRes.status === 401) {
        setNeedsLogin(true);
        setMsg("Session expired. Please login again.");
        return;
      }
      if (meRes.status === 404) {
        setMsg("API server is outdated. Restart backend so /auth/me is available.");
        return;
      }
      const cardsData = await cardsRes.json();
      const summaryData = await summaryRes.json();
      const meData = await meRes.json();
      setCards(cardsData.cards ?? []);
      setSummary(summaryData);
      socket = io(SOCKET_BASE);
      socket.emit(SOCKET_EVENTS.JOIN_USER, meData?.user?.userId);
      socket.on(SOCKET_EVENTS.PORTFOLIO_UPDATED, (event) => {
        setSummary((prev) => ({ ...prev, cardsValue: event.portfolioValue, netWorth: (Number(event.portfolioValue) + Number(prev.availableBalance) + Number(prev.heldBalance)).toFixed(2) }));
        if (event.cards && Array.isArray(event.cards)) {
          setCards((prevCards) => prevCards.map((card) => {
            const updated = event.cards.find((c: any) => c.id === card.id);
            if (updated) return { ...card, market_value: updated.marketValue, pnl: (Number(updated.marketValue) - Number(updated.acquisitionValue)).toFixed(2) };
            return card;
          }));
        }
      });
      socket.on(SOCKET_EVENTS.PRICE_CARD_UPDATED, (payload: any) => {
        if (payload.cards && Array.isArray(payload.cards)) {
          setCards((prevCards) => prevCards.map((card) => {
            const updated = payload.cards.find((u: any) => u.id === card.id);
            if (updated) return { ...card, market_value: updated.value, pnl: (Number(updated.value) - Number(card.acquisition_value)).toFixed(2) };
            return card;
          }));
        }
      });
      socket.on(SOCKET_EVENTS.LISTING_CREATED, (payload: any) => {
        if (payload.seller_id === meData?.user?.userId) setCards((prevCards) => prevCards.map((card) => card.id === payload.cardId ? { ...card, market_state: "LISTED", listing_id: payload.id } : card));
      });
      socket.on(SOCKET_EVENTS.AUCTION_UPDATED, (payload: any) => {
        if (payload.sellerId === meData?.user?.userId && payload.status === "ACTIVE") setCards((prevCards) => prevCards.map((card) => card.id === payload.cardId ? { ...card, market_state: "IN_AUCTION", auction_id: payload.auctionId } : card));
      });
      socket.on(SOCKET_EVENTS.AUCTION_CLOSED, (payload: any) => {
        if (payload.sellerId === meData?.user?.userId) {
          if (payload.settlement?.winner_id) {
            setCards((prevCards) => prevCards.filter((card) => card.auction_id !== payload.auctionId));
            setMsg(`Your auction sold for $${payload.settlement.gross_amount}! Check your available balance.`);
          } else {
            setCards((prevCards) => prevCards.map((card) => card.auction_id === payload.auctionId ? { ...card, market_state: "NONE", auction_id: undefined } : card));
          }
        }
      });
      socket.on(SOCKET_EVENTS.LISTING_SOLD, (payload) => {
        if (payload.sellerId === meData?.user?.userId) {
          setMsg(`Your ${payload.cardName} sold for $${payload.price}! Check your available balance.`);
          setCards((prevCards) => prevCards.filter((card) => card.id !== payload.cardId));
        }
      });
    })().catch(() => setMsg("Failed to load collection"));
    return () => {
      socket?.disconnect();
    };
  }, []);

  async function listCard(cardId: string) {
    setListingCardId(cardId);
    const token = localStorage.getItem("token") || "";
    const price = listingPrice[cardId];
    if (!price || Number(price) <= 0) {
      setMsg("Please enter a valid price greater than $0.00");
      setTimeout(() => setMsg(""), 3000);
      setListingCardId("");
      return;
    }
    const res = await fetch(`${API_BASE}/listings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ cardId, price }) });
    const data = await res.json();
    setMsg(res.ok ? `Listed card ${data.listing.id}` : errorToMessage(data?.error, "Failed to list card"));
    setListingCardId("");
  }

  async function startAuction(cardId: string) {
    setAuctioningCardId(cardId);
    const token = localStorage.getItem("token") || "";
    const durationSeconds = Number(auctionDurationByCard[cardId] ?? "300");
    const res = await fetch(`${API_BASE}/auctions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ cardId, durationSeconds, idempotencyKey: uuid() }) });
    const data = await res.json();
    setMsg(res.ok ? `Auction started ${data.auction.id}` : errorToMessage(data?.error, "Failed to start auction"));
    setAuctioningCardId("");
  }

  const { filteredCards } = useCollectionFilter(cards, filterConfig);
  const { sortedCards } = useCollectionSort(filteredCards, sortConfig);
  const availableRarities = useMemo(() => [...new Set(cards.map((c) => c.rarity))], [cards]);
  const availableSets = useMemo(() => [...new Set(cards.map((c) => c.set_name))], [cards]);
  const totalFilteredValue = useMemo(() => sortedCards.reduce((sum, card) => sum + Number(card.market_value), 0).toFixed(2), [sortedCards]);
  const historyChange = useMemo(() => {
    if (history.length < 2) return { abs: "0.00", pct: "0.00" };
    const start = Number(history[0].value);
    const end = Number(history[history.length - 1].value);
    const abs = (end - start).toFixed(2);
    const pct = start > 0 ? (((end - start) / start) * 100).toFixed(2) : "0.00";
    return { abs, pct };
  }, [history]);

  const chartData = useMemo(() => history.map((h) => ({ value: Number(h.value), at: new Date(h.at).getTime() })), [history]);
  const xTickFormat = (ts: number) => {
    const date = new Date(ts);
    if (historyRange === "24h") return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const renderMarketBadge = (card: CollectionCard) => {
    if (card.market_state === "LISTED") return <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">Listed</span>;
    if (card.market_state === "IN_AUCTION") return <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">In Auction</span>;
    return null;
  };

  const handleSortFieldChange = (field: SortField) => setSortConfig((prev) => ({ ...prev, field }));
  const handleSortDirectionToggle = () => setSortConfig((prev) => ({ ...prev, direction: prev.direction === "asc" ? "desc" : "asc" }));
  const handleRarityToggle = (rarity: string) => setFilterConfig((prev) => ({ ...prev, rarities: prev.rarities.includes(rarity) ? prev.rarities.filter((r) => r !== rarity) : [...prev.rarities, rarity] }));
  const handleSetToggle = (set: string) => setFilterConfig((prev) => ({ ...prev, sets: prev.sets.includes(set) ? prev.sets.filter((s) => s !== set) : [...prev.sets, set] }));
  const handleValueRangeChange = (min: number, max: number) => setFilterConfig((prev) => ({ ...prev, valueRange: min > 0 || max > 0 ? { min, max } : null }));
  const handleClearFilters = () => setFilterConfig({ rarities: [], sets: [], valueRange: null });

  return (
    <div className="page-stack">
      <h1 className="fluid-title">Collection</h1>
      {msg && <p className="safe-break text-sm sm:text-base">{msg}</p>}
      {needsLogin && <Link href="/auth" className="touch-btn inline-flex bg-cyan-500 text-slate-900">Go to Login</Link>}
      {!needsLogin && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card"><p>Cards Value</p><p className="text-xl font-semibold sm:text-2xl">${summary.cardsValue}</p></div>
            <div className="card"><p>Available</p><p className="text-xl font-semibold sm:text-2xl">${summary.availableBalance}</p></div>
            <div className="card"><p>Held</p><p className="text-xl font-semibold sm:text-2xl">${summary.heldBalance}</p></div>
            <div className="card"><p>Net Worth</p><p className="text-xl font-semibold sm:text-2xl">${summary.netWorth}</p></div>
          </div>

          <div className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Portfolio Performance</h2>
              <div className="flex gap-2">
                {(["24h", "7d", "30d"] as const).map((range) => (
                  <button
                    key={range}
                    className={`touch-btn ${historyRange === range ? "bg-cyan-500 text-slate-900" : "bg-slate-200 text-slate-900"}`}
                    onClick={() => setHistoryRange(range)}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>
            <p className={`text-sm ${Number(historyChange.abs) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {Number(historyChange.abs) >= 0 ? "+" : ""}${historyChange.abs} ({Number(historyChange.pct) >= 0 ? "+" : ""}{historyChange.pct}%)
            </p>
            {history.length < 2 ? (
              <p className="text-sm text-slate-400">Not enough data yet. Snapshot worker fills this over time.</p>
            ) : (
              <div className="rounded bg-slate-800/40 p-2">
                <div className="h-48 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 8 }}>
                      <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="at"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        tickFormatter={xTickFormat}
                        tick={{ fill: "#94a3b8", fontSize: 12 }}
                        stroke="#475569"
                      />
                      <YAxis
                        dataKey="value"
                        tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                        tick={{ fill: "#94a3b8", fontSize: 12 }}
                        stroke="#475569"
                        width={52}
                      />
                      <Tooltip
                        labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                        formatter={(value) => [`$${Number(value).toFixed(2)}`, "Net Worth"]}
                        contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: "0.5rem", color: "#e2e8f0" }}
                      />
                      <Line dataKey="value" type="monotone" stroke="#22d3ee" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex justify-between text-xs text-slate-400">
                  <span>{new Date(history[0].at).toLocaleString()}</span>
                  <span>{new Date(history[history.length - 1].at).toLocaleString()}</span>
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <SortControls currentSort={sortConfig} onSortChange={handleSortFieldChange} onDirectionToggle={handleSortDirectionToggle} />
            <FilterControls currentFilter={filterConfig} availableRarities={availableRarities} availableSets={availableSets} onRarityToggle={handleRarityToggle} onSetToggle={handleSetToggle} onValueRangeChange={handleValueRangeChange} onClearFilters={handleClearFilters} />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold sm:text-xl">Your Cards</h2>
            <p className="text-sm text-slate-400">Showing {sortedCards.length} of {cards.length} cards (${totalFilteredValue})</p>
          </div>

          {sortedCards.length === 0 ? (
            <div className="card">
              <p>No cards match your current filters.</p>
              <button className="touch-btn mt-2 bg-cyan-500 text-slate-900" onClick={handleClearFilters}>Clear Filters</button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {sortedCards.map((card) => (
                <div className="card space-y-2" key={card.id}>
                  <div className="flex items-start justify-between gap-3">
                    <img src={card.image_url} alt={card.name} className="safe-media h-36 w-36 rounded sm:h-40 sm:w-40" />
                    <div className="flex flex-col gap-1">{renderMarketBadge(card)}</div>
                  </div>
                  <h2 className="safe-break text-lg font-semibold">{card.name}</h2>
                  <p className="safe-break">{card.set_name} - {card.rarity}</p>
                  <p>Market: ${card.market_value}</p>
                  <p className={Number(card.pnl) >= 0 ? "text-emerald-400" : "text-rose-400"}>P/L: ${card.pnl}</p>
                  <button
                    className="touch-btn w-full bg-slate-200 text-slate-900 sm:w-auto"
                    onClick={() => setSelectedCard(card)}
                  >
                    View details
                  </button>
                  {card.market_state === "NONE" || !card.market_state ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <input className="touch-input w-full sm:w-36" value={listingPrice[card.id] ?? ""} onChange={(e) => setListingPrice((prev) => ({ ...prev, [card.id]: e.target.value }))} placeholder="List price" />
                        <button className="touch-btn w-full bg-cyan-500 text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" onClick={() => listCard(card.id)} disabled={!listingPrice[card.id] || Number(listingPrice[card.id]) <= 0 || listingCardId === card.id}>
                          {listingCardId === card.id ? "Listing..." : "List"}
                        </button>
                        <button className="touch-btn w-full bg-amber-400 text-slate-900 disabled:opacity-60 sm:w-auto" onClick={() => startAuction(card.id)} disabled={auctioningCardId === card.id}>
                          {auctioningCardId === card.id ? "Starting..." : "Auction"}
                        </button>
                        <select
                          className="touch-input w-full sm:w-36"
                          value={auctionDurationByCard[card.id] ?? "300"}
                          onChange={(e) => setAuctionDurationByCard((prev) => ({ ...prev, [card.id]: e.target.value }))}
                        >
                          <option value="60">1m (60s)</option>
                          <option value="300">5m (300s)</option>
                          <option value="900">15m (900s)</option>
                        </select>
                      </div>
                      <p className="text-xs text-slate-400">
                        Sale fees: Marketplace {(FEES.TRADE_FEE_RATE * 100).toFixed(0)}%, Auction {(FEES.AUCTION_FEE_RATE * 100).toFixed(0)}% (charged only if sold).
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">{card.market_state === "LISTED" ? "Card is listed in marketplace" : "Card is in auction"}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {selectedCard && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60">
          <div className="h-full w-full max-w-md overflow-y-auto border-l border-slate-700 bg-slate-900 p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Card Details</h2>
              <button className="touch-btn bg-slate-200 text-slate-900" onClick={() => setSelectedCard(null)}>Close</button>
            </div>
            <div className="space-y-3">
              <img src={selectedCard.image_url} alt={selectedCard.name} className="safe-media h-48 w-48 rounded" />
              <p className="safe-break text-lg font-semibold">{selectedCard.name}</p>
              <p className="safe-break text-sm text-slate-300">{selectedCard.set_name} - {selectedCard.rarity}</p>
              <p className="safe-break text-xs text-slate-400">Card ID: {selectedCard.id}</p>
              <div className="rounded bg-slate-800/60 p-3 text-sm">
                <p>Market Value: ${selectedCard.market_value}</p>
                <p>Acquisition Value: ${selectedCard.acquisition_value}</p>
                <p>P/L: ${selectedCard.pnl}</p>
                <p>P/L %: {Number(selectedCard.acquisition_value) > 0 ? ((Number(selectedCard.market_value) - Number(selectedCard.acquisition_value)) / Number(selectedCard.acquisition_value) * 100).toFixed(2) : "0.00"}%</p>
              </div>
              <div className="rounded bg-slate-800/60 p-3 text-sm">
                <p>Market State: {selectedCard.market_state ?? "NONE"}</p>
                <p className="safe-break">Listing ID: {selectedCard.listing_id ?? "-"}</p>
                <p className="safe-break">Auction ID: {selectedCard.auction_id ?? "-"}</p>
              </div>
              <p className="text-sm text-slate-300">Acquired: {new Date(selectedCard.created_at).toLocaleString()}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
