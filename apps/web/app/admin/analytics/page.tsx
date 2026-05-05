"use client";
import { useEffect, useMemo, useState } from "react";
import { io, Socket } from "socket.io-client";
import { API_BASE } from "../../../lib/config";
import { AnalyticsDashboardData, SOCKET_EVENTS } from "@pullvault/common";

function MetricCard({ label, value, highlight = false }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`card ${highlight ? "border-cyan-500 border-2" : ""}`}>
      <p className="text-sm text-slate-300">{label}</p>
      <p className={`text-xl font-semibold ${highlight ? "text-cyan-400" : ""}`}>{value}</p>
    </div>
  );
}

function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return `${(v * 100).toFixed(2)}%`;
}

export default function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [simulated, setSimulated] = useState<AnalyticsDashboardData | null>(null);

  const renderedData = simulated ?? data;
  console.log("renderedData", renderedData);

  useEffect(() => {
    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, 30000);
    let socket: Socket | null = null;
    try {
      socket = io(API_BASE, { transports: ["websocket"] });
      socket.on(SOCKET_EVENTS.ANALYTICS_DASHBOARD_INVALIDATED, () => {
        fetchAnalytics();
      });
    } catch {
      socket = null;
    }
    return () => {
      clearInterval(interval);
      socket?.disconnect();
    };
  }, []);

  async function fetchAnalytics() {
    const token = localStorage.getItem("token") || "";
    try {
      const res = await fetch(`${API_BASE}/analytics/dashboard`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const payload = await res.json();
        setData(payload);
        setSimulated(null);
        setError("");
      } else {
        setError("Access denied - admin only");
      }
    } catch {
      setError("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }

  const sortedAlerts = useMemo(
    () => (renderedData?.alerts ?? []).slice().sort((a, b) => {
      const rank = { CRITICAL: 0, WARN: 1, INFO: 2 };
      return rank[a.level] - rank[b.level];
    }),
    [renderedData]
  );

  function simulateMarginDrop() {
    if (!data) return;
    const clone: AnalyticsDashboardData = JSON.parse(JSON.stringify(data));
    const tier = clone.economicHealth.tiers[0];
    if (tier && tier.targetMargin !== null) {
      // Simulate a 10pp drop below target
      tier.realizedMargin24h = Math.max(0, tier.targetMargin - 0.1);
      tier.marginDeltaFromTarget = Number((tier.realizedMargin24h - tier.targetMargin).toFixed(4));

      // Mimic server-side buildEconomicAlerts logic
      const delta = tier.marginDeltaFromTarget;
      let level: "CRITICAL" | "WARN" | "INFO" = "INFO";
      let code = "MARGIN_DROP_CRITICAL";

      if (delta <= -0.08) {
        level = "CRITICAL";
        code = "MARGIN_DROP_CRITICAL";
      } else if (delta <= -0.05) {
        level = "WARN";
        code = "MARGIN_DROP_WARN";
      }

      clone.alerts = [
        {
          level,
          code: `SIMULATED_${code}`,
          tier: tier.tier,
          message: `${tier.tier}: simulated ${level.toLowerCase()} margin drop (${(Math.abs(delta) * 100).toFixed(1)}pp below target)`,
          value: delta
        },
        ...clone.alerts
      ];
    }
    setSimulated(clone);
  }

  if (loading) return <div className="card">Loading analytics...</div>;
  if (error) return <div className="card text-rose-400">{error}</div>;
  if (!renderedData) return <div className="card">No data available</div>;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Platform Health Dashboard</h1>
        <div className="flex gap-2">
          <button className="touch-btn bg-slate-700 text-white" onClick={fetchAnalytics}>Refresh</button>
          <button className="touch-btn bg-cyan-500 text-slate-900" onClick={simulateMarginDrop}>Simulate Margin Drop</button>
        </div>
      </div>

      <section className="card space-y-3">
        <h2 className="text-xl font-semibold">Alerts</h2>
        {sortedAlerts.length === 0 && <p className="text-sm text-slate-400">No active alerts.</p>}
        <div className="space-y-2">
          {sortedAlerts.map((alert, idx) => (
            <div key={`${alert.code}-${idx}`} className="rounded border border-slate-700 p-2 text-sm">
              <p className={`${alert.level === "CRITICAL" ? "text-rose-400" : alert.level === "WARN" ? "text-amber-400" : "text-slate-300"} font-semibold`}>
                {alert.level} {alert.tier ? `- ${alert.tier}` : ""}
              </p>
              <p>{alert.message}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Fraud Health</h2>
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Protected Requests (24h)" value={renderedData.fraudHealth.totalProtectedRequests} />
          <MetricCard label="Blocked Requests" value={renderedData.fraudHealth.blockedRequests} />
          <MetricCard label="Rate Limit Effectiveness" value={formatPct(renderedData.fraudHealth.rateLimitEffectiveness)} />
          <MetricCard label="High Risk Accounts" value={renderedData.fraudHealth.highRiskAccountCount} highlight />
          <MetricCard label="Bot Throttles" value={renderedData.fraudHealth.botThrottleCount} />
          <MetricCard label="Bot Blocks" value={renderedData.fraudHealth.botBlockCount} />
          <MetricCard label="Degraded Open" value={renderedData.fraudHealth.degradedOpenCount} />
          <MetricCard label="Top Blocked Bucket" value={renderedData.fraudHealth.topBlockedBucket ?? "-"} />
        </div>

        {renderedData.fraudHealth.flaggedAccounts.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <h3 className="text-md font-medium text-slate-300 mb-2">High Risk Flagged Accounts</h3>
            <table className="min-w-full text-xs text-left text-slate-400">
              <thead className="bg-slate-800 text-slate-300 uppercase">
                <tr>
                  <th className="px-3 py-2">User ID</th>
                  <th className="px-3 py-2">Max Score</th>
                  <th className="px-3 py-2">Events</th>
                  <th className="px-3 py-2">Latest Action</th>
                  <th className="px-3 py-2">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {renderedData.fraudHealth.flaggedAccounts.map((acc, i) => (
                  <tr key={i} className="border-b border-slate-700">
                    <td className="px-3 py-2 font-mono">{acc.userId?.slice(0, 8) ?? "anon"}...</td>
                    <td className={`px-3 py-2 ${acc.maxScore >= 0.7 ? "text-rose-400" : "text-amber-400"}`}>{acc.maxScore.toFixed(2)}</td>
                    <td className="px-3 py-2">{acc.recentEvents}</td>
                    <td className="px-3 py-2">{acc.latestAction}</td>
                    <td className="px-3 py-2">{new Date(acc.latestSeenAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Economic Health</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard label="Trailing Revenue (24h)" value={`$${renderedData.economicHealth.trailingRevenue24h}`} />
          <MetricCard label="Projected Daily Revenue" value={`$${renderedData.economicHealth.projectedRevenueDaily}`} />
          <MetricCard label="Projected 30d Revenue" value={`$${renderedData.economicHealth.projectedRevenue30d}`} />
        </div>
        <div className="space-y-3">
          {renderedData.economicHealth.tiers.map((tier) => (
            <div key={tier.tier} className="rounded border border-slate-700 p-3">
              <div className="grid gap-3 md:grid-cols-6 text-sm">
                <p><span className="text-slate-400">Tier:</span> {tier.tier}</p>
                <p><span className="text-slate-400">Sales:</span> {tier.salesCount24h}</p>
                <p><span className="text-slate-400">Revenue:</span> ${tier.revenue24h}</p>
                <p><span className="text-slate-400">COGS:</span> ${tier.realizedCogs24h}</p>
                <p><span className="text-slate-400">Actual Margin:</span> {formatPct(tier.realizedMargin24h)}</p>
                <p><span className="text-slate-400">Target Margin:</span> {formatPct(tier.targetMargin)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">Fairness Audit</h2>
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Sample Size (7d)" value={renderedData.fairnessAudit.sampleSize} />
          <MetricCard label="Chi-Squared" value={renderedData.fairnessAudit.statistic ?? "-"} />
          <MetricCard label="P-Value" value={renderedData.fairnessAudit.pValue ?? "-"} />
          <MetricCard label="Significance" value={renderedData.fairnessAudit.significance} highlight={renderedData.fairnessAudit.significance !== "PASS"} />
          <MetricCard label="Verification Users" value={renderedData.fairnessAudit.verificationUsers} />
          <MetricCard label="Verification Sessions" value={renderedData.fairnessAudit.verificationSessions} />
        </div>

        <div className="mt-4 overflow-x-auto">
          <h3 className="text-md font-medium text-slate-300 mb-2">Rarity Distribution (Chi-Squared Observed vs Expected)</h3>
          <table className="min-w-full text-xs text-left text-slate-400">
            <thead className="bg-slate-800 text-slate-300 uppercase">
              <tr>
                <th className="px-3 py-2">Rarity</th>
                <th className="px-3 py-2">Observed Hits</th>
                <th className="px-3 py-2">Expected Hits</th>
                <th className="px-3 py-2">Deviation</th>
              </tr>
            </thead>
            <tbody>
              {renderedData.fairnessAudit.observedExpectedByRarity.map((row, i) => {
                const diff = row.observed - row.expected;
                const pct = row.expected > 0 ? (diff / row.expected) * 100 : 0;
                return (
                  <tr key={i} className="border-b border-slate-700">
                    <td className="px-3 py-2 text-slate-200">{row.rarity}</td>
                    <td className="px-3 py-2">{row.observed}</td>
                    <td className="px-3 py-2">{row.expected.toFixed(2)}</td>
                    <td className={`px-3 py-2 ${Math.abs(pct) > 20 ? "text-rose-400" : "text-slate-400"}`}>
                      {diff > 0 ? "+" : ""}{diff.toFixed(1)} ({pct > 0 ? "+" : ""}{pct.toFixed(1)}%)
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[10px] text-slate-500 mt-2">
            * Chi-Squared test ignores categories where expected frequency is &lt; 5 to maintain statistical validity.
          </p>
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="text-xl font-semibold">User Health</h2>
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Health Status" value={renderedData.userHealth.status} highlight={renderedData.userHealth.status !== "healthy"} />
          <MetricCard label="Auction Participation" value={formatPct(renderedData.userHealth.auctionParticipationRate)} />
          <MetricCard label="Avg Bidders / Auction" value={renderedData.userHealth.averageBiddersPerAuction} />
          <MetricCard label="Drop Sell Through" value={formatPct(renderedData.userHealth.liveDropSellThrough)} />
          <MetricCard label="Listings Created (24h)" value={renderedData.userHealth.listingsCreated24h} />
          <MetricCard label="Trades Completed (24h)" value={renderedData.userHealth.tradesCompleted24h} />
          <MetricCard label="D1 Retention" value={formatPct(renderedData.userHealth.d1Retention)} />
          <MetricCard label="D7 Retention" value={formatPct(renderedData.userHealth.d7Retention)} />
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-xl font-semibold">Core Economics (Existing)</h2>
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Pack Revenue" value={`$${renderedData.revenue.packRevenue}`} />
          <MetricCard label="Trading Fees" value={`$${renderedData.revenue.tradeFees}`} />
          <MetricCard label="Auction Fees" value={`$${renderedData.revenue.auctionFees}`} />
          <MetricCard label="Gross Revenue" value={`$${renderedData.revenue.totalRevenue}`} highlight />
        </div>
      </section>

      <p className="text-sm text-slate-500">
        Last updated: {new Date(renderedData.generatedAt).toLocaleString()} | Live updates enabled with 30s polling fallback.
      </p>
    </div>
  );
}
