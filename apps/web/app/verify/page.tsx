"use client";
import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "../../lib/config";
import { verifyPackOpeningProof, type FairCard } from "@pullvault/common";

type Proof = {
  purchaseId: string;
  dropId: string;
  configVersionId: string | null;
  clientSeed: string;
  serverSeed: string;
  serverSeedHash: string;
  nonce: number;
  cardsPerPack: number;
  rarityWeightMicros: Record<string, number>;
  cardPool: FairCard[];
  selectedCardsHash: string;
  cards: RevealCard[];
};

type RevealCard = FairCard & { acquisitionValue: string };

export default function VerifyPage() {
  const [purchaseId, setPurchaseId] = useState("");
  const [proof, setProof] = useState<Proof | null>(null);
  const [cards, setCards] = useState<RevealCard[]>([]);
  const [result, setResult] = useState<{ ok: boolean; checks: Record<string, boolean> } | null>(null);
  const [msg, setMsg] = useState("");

  const queryPurchaseId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("purchaseId") ?? "";
  }, []);

  useEffect(() => {
    if (queryPurchaseId) setPurchaseId(queryPurchaseId);
  }, [queryPurchaseId]);

  async function runVerification(targetId: string) {
    setMsg("");
    setResult(null);
    const proofResp = await fetch(`${API_BASE}/provably-fair/openings/${targetId}`);
    const proofData = await proofResp.json();
    if (!proofResp.ok) {
      setMsg(proofData.error ?? "Proof not found");
      return;
    }
    const revealCards: RevealCard[] = proofData.cards ?? [];
    setProof(proofData);
    setCards(revealCards);
    const verified = await verifyPackOpeningProof({
      serverSeed: proofData.serverSeed,
      serverSeedHash: proofData.serverSeedHash,
      purchaseId: proofData.purchaseId,
      dropId: proofData.dropId,
      configVersionId: proofData.configVersionId,
      clientSeed: proofData.clientSeed,
      nonce: proofData.nonce,
      cardsPerPack: proofData.cardsPerPack,
      rarityWeightMicros: proofData.rarityWeightMicros,
      cardPool: proofData.cardPool,
      expectedCardPoolHash: proofData.cardPoolHash,
      revealedCards: revealCards,
      expectedSelectedCardsHash: proofData.selectedCardsHash
    });
    setResult(verified);

    const token = localStorage.getItem("token") || "";
    await fetch(`${API_BASE}/provably-fair/verification-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        purchaseId: targetId,
        ok: verified.ok,
        checks: verified.checks,
        clientFingerprint: `${navigator.userAgent}:${navigator.language}`
      })
    }).catch(() => undefined);
  }

  return (
    <div className="page-stack">
      <h1 className="fluid-title">Pack Verification</h1>
      <div className="card space-y-2">
        <h2 className="text-lg font-semibold">How verification works</h2>
        <p className="text-sm text-slate-300">
          This page recomputes pack results in your browser using the revealed server seed, your client seed, and
          the committed card pool snapshot. It does not ask the server whether the result is correct.
        </p>
        <p className="text-sm text-slate-300">
          A valid opening should pass cryptographic integrity checks: seed commitment, pool hash, and selected cards hash.
        </p>
      </div>
      <div className="card space-y-3">
        <input
          className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2"
          placeholder="Purchase ID"
          value={purchaseId}
          onChange={(e) => setPurchaseId(e.target.value)}
        />
        <button className="touch-btn w-full bg-cyan-500 text-slate-900 sm:w-auto" onClick={() => runVerification(purchaseId)} disabled={!purchaseId}>
          Verify Opening
        </button>
      </div>
      {msg && <p className="text-rose-400">{msg}</p>}
      {proof && result && (
        <div className="card space-y-2">
          <p>Overall cryptographic integrity: <strong className={result.ok ? "text-emerald-400" : "text-rose-400"}>{result.ok ? "PASS" : "FAIL"}</strong></p>
          <p>Seed commitment: {result.checks.seedHash ? "PASS" : "FAIL"}</p>
          <p>Card derivation consistency: {result.checks.cards ? "PASS" : "FAIL"}</p>
          <p>Card pool hash: {result.checks.poolHash ? "PASS" : "FAIL"}</p>
          <p>Cards hash: {result.checks.cardsHash ? "PASS" : "FAIL"}</p>
          <details className="rounded border border-slate-700 p-3">
            <summary className="cursor-pointer">Proof Inputs</summary>
            <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(proof, null, 2)}</pre>
            <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(cards, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
