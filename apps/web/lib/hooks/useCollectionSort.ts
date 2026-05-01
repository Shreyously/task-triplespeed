import { useMemo } from 'react';
import { SortConfig } from '../collectionTypes';

export interface Card {
  id: string;
  name: string;
  set_name: string;
  rarity: string;
  image_url: string;
  market_value: string;
  pnl: string;
  created_at: string;
}

export function useCollectionSort(cards: Card[], sortConfig: SortConfig) {
  const sortedCards = useMemo(() => {
    const { field, direction } = sortConfig;
    const multiplier = direction === 'asc' ? 1 : -1;

    return [...cards].sort((a, b) => {
      // Rarity sorting (by value tier)
      if (field === 'rarity') {
        const rarityOrder: Record<string, number> = {
          'Secret Rare': 6,
          'Ultra Rare/EX/GX': 5,
          'Holo Rare': 4,
          'Rare': 3,
          'Uncommon': 2,
          'Common': 1
        };
        const rarityDiff = (rarityOrder[a.rarity] || 0) - (rarityOrder[b.rarity] || 0);
        return rarityDiff * multiplier;
      }

      // Numeric fields
      if (field === 'market_value' || field === 'pnl') {
        return (Number(a[field]) - Number(b[field])) * multiplier;
      }

      // Date field
      if (field === 'created_at') {
        return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * multiplier;
      }

      // String field (name)
      if (field === 'name') {
        return a[field].localeCompare(b[field]) * multiplier;
      }

      return 0;
    });
  }, [cards, sortConfig]);

  return { sortedCards };
}
