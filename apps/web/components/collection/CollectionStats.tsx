interface CollectionStatsProps {
  totalCards: number;
  filteredCards: number;
  totalValue: string;
}

export function CollectionStats({ totalCards, filteredCards, totalValue }: CollectionStatsProps) {
  return (
    <div className="card">
      <p className="text-sm text-slate-300">
        Showing {filteredCards} of {totalCards} cards
      </p>
      <p className="text-lg font-semibold">Total Value: ${totalValue}</p>
    </div>
  );
}
