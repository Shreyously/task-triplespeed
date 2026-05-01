import { FilterConfig } from '../../lib/collectionTypes';

interface FilterControlsProps {
  currentFilter: FilterConfig;
  availableRarities: string[];
  availableSets: string[];
  onRarityToggle: (rarity: string) => void;
  onSetToggle: (set: string) => void;
  onValueRangeChange: (min: number, max: number) => void;
  onClearFilters: () => void;
}

export function FilterControls({
  currentFilter,
  availableRarities,
  availableSets,
  onRarityToggle,
  onSetToggle,
  onValueRangeChange,
  onClearFilters
}: FilterControlsProps) {
  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Filters</h3>
        <button
          className="text-sm text-cyan-500 hover:underline"
          onClick={onClearFilters}
        >
          Clear All
        </button>
      </div>

      {/* Rarity Filter */}
      <div className="space-y-2">
        <label className="text-sm text-slate-300">Rarity</label>
        <div className="space-y-1">
          {availableRarities.map(rarity => (
            <label key={rarity} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={currentFilter.rarities.includes(rarity)}
                onChange={() => onRarityToggle(rarity)}
                className="rounded"
              />
              {rarity}
            </label>
          ))}
        </div>
      </div>

      {/* Set Filter */}
      <div className="space-y-2">
        <label className="text-sm text-slate-300">Set</label>
        <div className="max-h-32 space-y-1 overflow-y-auto">
          {availableSets.map(set => (
            <label key={set} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={currentFilter.sets.includes(set)}
                onChange={() => onSetToggle(set)}
                className="rounded"
              />
              {set}
            </label>
          ))}
        </div>
      </div>

      {/* Value Range Filter */}
      <div className="space-y-2">
        <label className="text-sm text-slate-300">Market Value Range</label>
        <div className="flex gap-2">
          <input
            type="number"
            placeholder="Min"
            className="w-24 rounded bg-slate-800 px-2 py-1"
            value={currentFilter.valueRange?.min ?? ''}
            onChange={(e) => onValueRangeChange(Number(e.target.value), currentFilter.valueRange?.max ?? 0)}
          />
          <span className="py-1">-</span>
          <input
            type="number"
            placeholder="Max"
            className="w-24 rounded bg-slate-800 px-2 py-1"
            value={currentFilter.valueRange?.max ?? ''}
            onChange={(e) => onValueRangeChange(currentFilter.valueRange?.min ?? 0, Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
}
