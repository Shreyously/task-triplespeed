import { useMemo } from 'react';
import { FilterConfig } from '../collectionTypes';
import { Card } from './useCollectionSort';

export function useCollectionFilter(cards: Card[], filterConfig: FilterConfig) {
  const filteredCards = useMemo(() => {
    return cards.filter(card => {
      // Filter by rarity
      if (filterConfig.rarities.length > 0 && !filterConfig.rarities.includes(card.rarity)) {
        return false;
      }

      // Filter by set
      if (filterConfig.sets.length > 0 && !filterConfig.sets.includes(card.set_name)) {
        return false;
      }

      // Filter by value range
      if (filterConfig.valueRange) {
        const value = Number(card.market_value);
        if (value < filterConfig.valueRange.min || value > filterConfig.valueRange.max) {
          return false;
        }
      }

      return true;
    });
  }, [cards, filterConfig]);

  return { filteredCards };
}
