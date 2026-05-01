import { useEffect } from 'react';
import { SortConfig, FilterConfig } from '../collectionTypes';

const STORAGE_KEY = 'collection_preferences';

export function useCollectionPersistence(
  sortConfig: SortConfig,
  filterConfig: FilterConfig,
  setSortConfig: (config: SortConfig) => void,
  setFilterConfig: (config: FilterConfig) => void
) {
  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const { sort, filter } = JSON.parse(stored);
        setSortConfig(sort);
        setFilterConfig(filter);
      } catch (e) {
        console.error('Failed to parse collection preferences:', e);
      }
    }
  }, [setSortConfig, setFilterConfig]);

  // Save to localStorage on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sort: sortConfig,
      filter: filterConfig
    }));
  }, [sortConfig, filterConfig]);
}
