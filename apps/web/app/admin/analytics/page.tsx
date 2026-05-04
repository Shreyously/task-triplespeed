"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "../../../lib/config";
import {
  AnalyticsDashboardData
} from "@pullvault/common";

function MetricCard({ label, value, highlight = false }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`card ${highlight ? "border-cyan-500 border-2" : ""}`}>
      <p className="text-sm text-slate-300">{label}</p>
      <p className={`text-xl font-semibold ${highlight ? "text-cyan-400" : ""}`}>{value}</p>
    </div>
  );
}

export default function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  async function fetchAnalytics() {
    const token = localStorage.getItem("token") || "";
    try {
      const res = await fetch(`${API_BASE}/analytics/dashboard`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setData(await res.json());
        setError("");
      } else {
        setError("Access denied - admin only");
      }
    } catch (e) {
      setError("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="card">Loading analytics...</div>;
  if (error) return <div className="card text-rose-400">{error}</div>;
  if (!data) return <div className="card">No data available</div>;

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Platform Economics Dashboard</h1>

      {/* Revenue Breakdown */}
      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Revenue Breakdown</h2>
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Pack Revenue" value={`$${data.revenue.packRevenue}`} />
          <MetricCard label="Trading Fees" value={`$${data.revenue.tradeFees}`} />
          <MetricCard label="Auction Fees" value={`$${data.revenue.auctionFees}`} />
          <MetricCard label="Gross Revenue" value={`$${data.revenue.totalRevenue}`} highlight />
        </div>
        <p className="text-xs text-slate-400">
          Gross Revenue = Pack Revenue + Trading Fees + Auction Fees
        </p>
      </section>

      {/* Transaction Volumes */}
      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Transaction Volume (24h)</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <p className="text-sm text-slate-300">Trades</p>
            <p className="text-lg font-semibold">{data.volumes.trades.count} trades</p>
            <p className="text-sm text-slate-400">${data.volumes.trades.totalVolume} volume</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-slate-300">Auctions</p>
            <p className="text-lg font-semibold">{data.volumes.auctions.count} auctions</p>
            <p className="text-sm text-slate-400">${data.volumes.auctions.totalVolume} volume</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-slate-300">Pack Sales</p>
            <p className="text-lg font-semibold">{data.volumes.packs.count} packs</p>
            <p className="text-sm text-slate-400">${data.volumes.packs.totalVolume} revenue</p>
          </div>
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Auction Integrity</h2>
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Participation Rate" value={`${data.auctionIntegrity.participationRate}%`} />
          <MetricCard label="Avg Bidders" value={data.auctionIntegrity.averageBidders} />
          <MetricCard label="Sealed Endgame Rate" value={`${data.auctionIntegrity.sealedEndgameRate}%`} />
          <MetricCard label="Flag Rate" value={`${data.auctionIntegrity.flagRate}%`} highlight={data.auctionIntegrity.flagRate > 0} />
          <MetricCard label="Low Close Rate" value={`${data.auctionIntegrity.lowCloseRate}%`} />
          <MetricCard label="Snipe Rate" value={`${data.auctionIntegrity.snipeRate}%`} />
          <MetricCard label="Review Flags" value={data.auctionIntegrity.auctionsReviewed} />
        </div>
      </section>

      {/* Pack EV Analysis */}
      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Pack Expected Value Analysis</h2>
        <div className="space-y-6">
          {data.evAnalysis.map((pack) => (
            <div key={pack.tier} className="border border-slate-700 rounded p-4 space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">{pack.tier} Pack</h3>
                <span className="text-2xl font-bold">${pack.price}</span>
              </div>
              <div className="grid gap-4 md:grid-cols-4">
                <MetricCard label="Cards" value={pack.cardsPerPack.toString()} />
                <MetricCard label="Expected Value" value={`$${pack.expectedValue}`} />
                <MetricCard label="Margin" value={`$${pack.margin}`} />
                <MetricCard
                  label="Margin %"
                  value={`${pack.marginPercentage.toFixed(1)}%`}
                  highlight={pack.marginPercentage > 0}
                />
              </div>
              <div className="space-y-2">
                <h4 className="font-semibold">Rarity Breakdown</h4>
                <div className="grid gap-2 text-sm">
                  {pack.rarityBreakdown.map((rb) => (
                    <div key={rb.rarity} className="flex justify-between border-b border-slate-700 pb-1">
                      <span>{rb.rarity} ({(rb.weight * 100).toFixed(0)}%)</span>
                      <span>${rb.contribution} EV</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Platform Profitability */}
      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Platform Profitability</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard label="Gross Revenue" value={`$${data.profitability.totalRevenue}`} />
          <MetricCard label="COGS (Realized)" value={`$${data.profitability.totalCosts}`} />
          <MetricCard label="Gross Profit" value={`$${data.profitability.grossProfit}`} highlight={Number(data.profitability.grossProfit) > 0} />
          <MetricCard
            label="Gross Profit Margin"
            value={`${data.profitability.profitMargin.toFixed(1)}%`}
            highlight={data.profitability.profitMargin > 0}
          />
        </div>
        <p className="text-xs text-slate-400">
          COGS (Realized) = Sum of assigned card acquisition values for sold packs.
        </p>
      </section>

      {/* Market Statistics */}
      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Market Statistics</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {data.marketStats.map((stat) => (
            <div key={stat.rarity} className="border border-slate-700 rounded p-3 space-y-2">
              <h3 className="font-semibold">{stat.rarity}</h3>
              <div className="space-y-1 text-sm">
                <p>Avg: ${stat.avgValue}</p>
                <p>Range: ${stat.minValue} - ${stat.maxValue}</p>
                <p>Cards: {stat.cardCount}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Flagged Auctions Review Queue</h2>
        {data.flaggedAuctions.length === 0 && (
          <p className="text-sm text-slate-400">No auction integrity flags have been raised yet.</p>
        )}
        <div className="space-y-3">
          {data.flaggedAuctions.map((flag) => (
            <div key={flag.id} className="rounded border border-slate-700 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{flag.flagType}</p>
                <p className="text-slate-400">Severity {flag.severity}</p>
              </div>
              <p>Auction: {flag.auctionId}</p>
              <p>Status: {flag.status}</p>
              <p>Final vs Market: ${flag.finalPrice ?? "0.00"} / ${flag.marketValue ?? "0.00"}</p>
              <p>Winner: {flag.winnerId ? `${flag.winnerId.slice(0, 8)}...` : "None"}</p>
              <p>Bidders: {flag.bidderCount}</p>
              <p className="text-slate-400">Flagged at {new Date(flag.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="text-sm text-slate-500">
        Last updated: {new Date(data.generatedAt).toLocaleString()}
      </p>
    </div>
  );
}
