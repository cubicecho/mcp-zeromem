import { Swatch } from './tooltip';

export interface LegendItem {
  key: string;
  label: string;
  color: string;
}

/** Present whenever a chart has two or more series; `other` names the fold, if any. */
export function Legend({
  items,
  other,
  shape = 'square',
}: {
  items: LegendItem[];
  other?: string;
  shape?: 'square' | 'line';
}) {
  if (items.length + (other ? 1 : 0) < 2) {
    return null;
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <Swatch color={item.color} shape={shape} />
          <span className="max-w-40 truncate text-foreground">{item.label}</span>
        </li>
      ))}
      {other && (
        <li className="flex items-center gap-1.5">
          <Swatch color="var(--viz-other)" shape={shape} />
          <span>{other}</span>
        </li>
      )}
    </ul>
  );
}
