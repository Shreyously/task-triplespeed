"use client";
import { useEffect, useState, useMemo } from "react";
import { io } from "socket.io-client";
import { API_BASE, SOCKET_BASE, uuid } from "../../lib/config";
import { SOCKET_EVENTS } from "@pullvault/common";
import Link from "next/link";
import { SortConfig, FilterConfig, SortField } from "../../lib/collectionTypes";
import { useCollectionSort } from "../../lib/hooks/useCollectionSort";
import { useCollectionFilter } from "../../lib/hooks/useCollectionFilter";
import { useCollectionPersistence } from "../../lib/hooks/useCollectionPersistence";
import { SortControls } from "../../components/collection/SortControls";
import { FilterControls } from "../../components/collection/FilterControls";
type Card = {
  id: string;
  name: string;
  set_name: string;
  rarity: string;
  image_url: string;
  market_value: string;
  acquisition_value: string;
  pnl: string;
  created_at: string;
  market_state?: string;
  listing_id?: string;
  auction_id?: string;
};

export default function CollectionPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [summary, setSummary] = useState({ cardsValue: "0.00", availableBalance: "0.00", heldBalance: "0.00", netWorth: "0.00" });
  const [msg, setMsg] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [listingPrice, setListingPrice] = useState<Record<string, string>>({});

  // Sort and filter state
  const [sortConfig, setSortConfig] = useState<SortConfig>({ field: 'created_at', direction: 'desc' });
  const [filterConfig, setFilterConfig] = useState<FilterConfig>({ rarities: [], sets: [], valueRange: null });

  // Persistence hook
  useCollectionPersistence(sortConfig, filterConfig, setSortConfig, setFilterConfig);

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
            if (updated) {
              const pnl = Number(updated.marketValue) - Number(updated.acquisitionValue);
              return {
                ...card,
                market_value: updated.marketValue,
                pnl: pnl.toFixed(2)
              };
            }
            return card;
          }));
        }
      });

      socket.on(SOCKET_EVENTS.PRICE_CARD_UPDATED, (payload: any) => {
        if (payload.cards && Array.isArray(payload.cards)) {
          setCards((prevCards) => prevCards.map((card) => {
            const updated = payload.cards.find((u: any) => u.id === card.id);
            if (updated) {
              const pnl = Number(updated.value) - Number(card.acquisition_value);
              return {
                ...card,
                market_value: updated.value,
                pnl: pnl.toFixed(2)
              };
            }
            return card;
          }));
        }
      });

      socket.on(SOCKET_EVENTS.LISTING_CREATED, (payload: any) => {
        if (payload.seller_id === meData?.user?.userId) {
          setCards((prevCards) => prevCards.map((card) => {
            if (card.id === payload.cardId) {
              return {
                ...card,
                market_state: "LISTED",
                listing_id: payload.id
              };
            }
            return card;
          }));
        }
      });

      socket.on(SOCKET_EVENTS.AUCTION_UPDATED, (payload: any) => {
        if (payload.sellerId === meData?.user?.userId && payload.status === "ACTIVE") {
          setCards((prevCards) => prevCards.map((card) => {
            if (card.id === payload.cardId) {
              return {
                ...card,
                market_state: "IN_AUCTION",
                auction_id: payload.auctionId
              };
            }
            return card;
          }));
        }
      });

      socket.on(SOCKET_EVENTS.AUCTION_CLOSED, (payload: any) => {
        if (payload.sellerId === meData?.user?.userId) {
          if (payload.settlement?.winner_id) {
            // Card was sold in auction, remove it from collection
            setCards((prevCards) => prevCards.filter((card) => card.id !== payload.cardId));
            setMsg(`🎵 Your auction sold for $${payload.settlement.gross_amount}! Check your available balance.`);
            setTimeout(() => setMsg(""), 5000);
          } else {
            // Auction ended without bids, card is available again
            setCards((prevCards) => prevCards.map((card) => {
              if (card.id === payload.cardId) {
                return {
                  ...card,
                  market_state: "NONE",
                  auction_id: undefined
                };
              }
              return card;
            }));
          }
        }
      });

      socket.on(SOCKET_EVENTS.LISTING_SOLD, (payload) => {
        if (payload.sellerId === meData?.user?.userId) {
          setMsg(`💰 Your ${payload.cardName} sold for $${payload.price}! Check your available balance.`);
          setTimeout(() => setMsg(""), 5000);
          // Remove the sold card from the collection
          setCards((prevCards) => prevCards.filter((card) => card.id !== payload.cardId));
        }
      });
    })().catch(() => setMsg("Failed to load collection"));
    return () => {
      socket?.disconnect();
    };
  }, []);

  async function listCard(cardId: string) {
    const token = localStorage.getItem("token") || "";
    const price = listingPrice[cardId];
    if (!price || Number(price) <= 0) {
      setMsg("Please enter a valid price greater than $0.00");
      setTimeout(() => setMsg(""), 3000);
      return;
    }
    const res = await fetch(`${API_BASE}/listings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ cardId, price })
    });
    const data = await res.json();
    setMsg(res.ok ? `Listed card ${data.listing.id}` : data.error);
  }

  async function startAuction(cardId: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${API_BASE}/auctions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ cardId, durationSeconds: 300, idempotencyKey: uuid() })
    });
    const data = await res.json();
    setMsg(res.ok ? `Auction started ${data.auction.id}` : data.error);
  }

  // Apply filtering and sorting
  const { filteredCards } = useCollectionFilter(cards, filterConfig);
  const { sortedCards } = useCollectionSort(filteredCards, sortConfig);

  // Calculate available options for filters
  const availableRarities = useMemo(() => [...new Set(cards.map(c => c.rarity))], [cards]);
  const availableSets = useMemo(() => [...new Set(cards.map(c => c.set_name))], [cards]);
  const totalFilteredValue = useMemo(() =>
    sortedCards.reduce((sum, card) => sum + Number(card.market_value), 0).toFixed(2),
    [sortedCards]
  );

  // Helper function to render market status badge
  const renderMarketBadge = (card: Card) => {
    if (card.market_state === "LISTED") {
      return (
        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
          Listed
        </span>
      );
    }
    if (card.market_state === "IN_AUCTION") {
      return (
        <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">
          In Auction
        </span>
      );
    }
    return null;
  };

  // Event handlers for sort/filter
  const handleSortFieldChange = (field: SortField) => {
    setSortConfig(prev => ({ ...prev, field }));
  };

  const handleSortDirectionToggle = () => {
    setSortConfig(prev => ({ ...prev, direction: prev.direction === 'asc' ? 'desc' : 'asc' }));
  };

  const handleRarityToggle = (rarity: string) => {
    setFilterConfig(prev => ({
      ...prev,
      rarities: prev.rarities.includes(rarity)
        ? prev.rarities.filter(r => r !== rarity)
        : [...prev.rarities, rarity]
    }));
  };

  const handleSetToggle = (set: string) => {
    setFilterConfig(prev => ({
      ...prev,
      sets: prev.sets.includes(set)
        ? prev.sets.filter(s => s !== set)
        : [...prev.sets, set]
    }));
  };

  const handleValueRangeChange = (min: number, max: number) => {
    setFilterConfig(prev => ({
      ...prev,
      valueRange: min > 0 || max > 0 ? { min, max } : null
    }));
  };

  const handleClearFilters = () => {
    setFilterConfig({ rarities: [], sets: [], valueRange: null });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Collection</h1>
      {msg && <p>{msg}</p>}
      {needsLogin && (
        <Link href="/auth" className="inline-block rounded bg-cyan-500 px-3 py-2 text-slate-900">
          Go to Login
        </Link>
      )}
      <div className="grid gap-3 md:grid-cols-4">
        <div className="card"><p>Cards Value</p><p className="text-xl font-semibold">${summary.cardsValue}</p></div>
        <div className="card"><p>Available</p><p className="text-xl font-semibold">${summary.availableBalance}</p></div>
        <div className="card"><p>Held</p><p className="text-xl font-semibold">${summary.heldBalance}</p></div>
        <div className="card"><p>Net Worth</p><p className="text-xl font-semibold">${summary.netWorth}</p></div>
      </div>

      {/* Controls Section */}
      <div className="grid gap-4 md:grid-cols-2">
        <SortControls
          currentSort={sortConfig}
          onSortChange={handleSortFieldChange}
          onDirectionToggle={handleSortDirectionToggle}
        />
        <FilterControls
          currentFilter={filterConfig}
          availableRarities={availableRarities}
          availableSets={availableSets}
          onRarityToggle={handleRarityToggle}
          onSetToggle={handleSetToggle}
          onValueRangeChange={handleValueRangeChange}
          onClearFilters={handleClearFilters}
        />
      </div>

      {/* Cards Grid */}
      <div className="flex items-center justify-between mt-4">
        <h2 className="text-xl font-semibold">Your Cards</h2>
        <p className="text-sm text-slate-400">Showing {sortedCards.length} of {cards.length} cards</p>
      </div>

      {sortedCards.length === 0 ? (
        <div className="card">
          <p>No cards match your current filters.</p>
          <button
            className="mt-2 rounded bg-cyan-500 px-3 py-2 text-slate-900"
            onClick={handleClearFilters}
          >
            Clear Filters
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sortedCards.map((card) => (
            <div className="card space-y-2" key={card.id}>
              <div className="flex items-start justify-between">
                <img src={card.image_url} alt={card.name} className="h-40 rounded object-contain" />
                <div className="flex flex-col gap-1">
                  {renderMarketBadge(card)}
                </div>
              </div>
              <h2 className="text-lg font-semibold">{card.name}</h2>
              <p>{card.set_name} - {card.rarity}</p>
              <p>Market: ${card.market_value}</p>
              <p className={Number(card.pnl) >= 0 ? "text-emerald-400" : "text-rose-400"}>P/L: ${card.pnl}</p>
              {card.market_state === "NONE" || !card.market_state ? (
                <div className="flex gap-2">
                  <input
                    className="w-28 rounded bg-slate-800 px-2 py-1"
                    value={listingPrice[card.id] ?? ""}
                    onChange={(e) => setListingPrice((prev) => ({ ...prev, [card.id]: e.target.value }))}
                    placeholder="List price"
                  />
                  <button
                    className="rounded bg-cyan-500 px-3 py-2 text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => listCard(card.id)}
                    disabled={!listingPrice[card.id] || Number(listingPrice[card.id]) <= 0}
                  >
                    List
                  </button>
                  <button className="rounded bg-amber-400 px-3 py-2 text-slate-900" onClick={() => startAuction(card.id)}>Auction</button>
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  {card.market_state === "LISTED" ? "Card is listed in marketplace" : "Card is in auction"}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
