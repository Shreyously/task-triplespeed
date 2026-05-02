export type SortField = 'name' | 'rarity' | 'market_value' | 'pnl' | 'created_at';
export type SortDirection = 'asc' | 'desc';

export interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

export interface FilterConfig {
  rarities: string[];
  sets: string[];
  valueRange: {
    min: number;
    max: number;
  } | null;
}

export interface CollectionViewState {
  sort: SortConfig;
  filter: FilterConfig;
}

export interface CollectionCard {
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
}

export const RARITY_OPTIONS = [
  'Common',
  'Uncommon',
  'Rare',
  'Holo Rare',
  'Ultra Rare/EX/GX',
  'Secret Rare'
] as const;

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  name: 'Card Name',
  rarity: 'Rarity',
  market_value: 'Market Value',
  pnl: 'Profit/Loss',
  created_at: 'Acquisition Date'
};
