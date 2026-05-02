import { SortConfig, SortField, SORT_FIELD_LABELS } from '../../lib/collectionTypes';

interface SortControlsProps {
  currentSort: SortConfig;
  onSortChange: (field: SortField) => void;
  onDirectionToggle: () => void;
}

export function SortControls({ currentSort, onSortChange, onDirectionToggle }: SortControlsProps) {
  return (
    <div className="card space-y-3">
      <h3 className="font-semibold">Sort By</h3>
      <select className="touch-input w-full" value={currentSort.field} onChange={(e) => onSortChange(e.target.value as SortField)}>
        {Object.entries(SORT_FIELD_LABELS).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <button className="touch-btn w-full bg-slate-700 hover:bg-slate-600" onClick={onDirectionToggle}>
        {currentSort.direction === 'asc' ? '? Ascending' : '? Descending'}
      </button>
    </div>
  );
}
