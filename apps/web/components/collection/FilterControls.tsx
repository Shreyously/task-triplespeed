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
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Filters</h3>
        <button className="text-sm text-cyan-500 hover:underline" onClick={onClearFilters}>Clear All</button>
      </div>

      <div className="space-y-2">
        <label className="text-sm text-slate-300">Rarity</label>
        <div className="grid gap-1 sm:grid-cols-2">
          {availableRarities.map((rarity) => (
            <label key={rarity} className="safe-break flex items-center gap-2 text-sm">
              <input type="checkbox" checked={currentFilter.rarities.includes(rarity)} onChange={() => onRarityToggle(rarity)} className="rounded" />
              {rarity}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm text-slate-300">Set</label>
        <div className="max-h-32 space-y-1 overflow-y-auto">
          {availableSets.map((set) => (
            <label key={set} className="safe-break flex items-center gap-2 text-sm">
              <input type="checkbox" checked={currentFilter.sets.includes(set)} onChange={() => onSetToggle(set)} className="rounded" />
              {set}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm text-slate-300">Market Value Range</label>
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
          <input
            type="number"
            placeholder="Min"
            className="touch-input w-full"
            value={currentFilter.valueRange?.min ?? ''}
            onChange={(e) => onValueRangeChange(Number(e.target.value), currentFilter.valueRange?.max ?? 0)}
          />
          <span className="py-2">-</span>
          <input
            type="number"
            placeholder="Max"
            className="touch-input w-full"
            value={currentFilter.valueRange?.max ?? ''}
            onChange={(e) => onValueRangeChange(currentFilter.valueRange?.min ?? 0, Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
}
