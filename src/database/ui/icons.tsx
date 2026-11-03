// Icônes linéaires 16 px (style SF Symbols), trait = currentColor.
import type { PropertyType, DbViewType } from '../../db/types';

const P: Record<string, string> = {
  text: 'M3 4h10M3 8h10M3 12h6',
  number: 'M6.2 2.5 4.6 13.5M11.4 2.5 9.8 13.5M2.5 6h11M2 10.2h11',
  select: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM5.6 7l2.4 2.4L10.4 7',
  multi_select: 'M6.5 4h7M6.5 8h7M6.5 12h7M3 4h.01M3 8h.01M3 12h.01',
  status: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 5a3 3 0 0 1 0 6z',
  date: 'M3.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5V5a1.5 1.5 0 0 1 1.5-1.5zM2 7h12M5.5 2v3M10.5 2v3',
  person: 'M8 8.2a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4zM3 13.6c.7-2.3 2.7-3.7 5-3.7s4.3 1.4 5 3.7',
  checkbox: 'M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM5.4 8.2l1.8 1.8 3.5-3.9',
  url: 'M7 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7',
  email: 'M3.2 3.5h9.6c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2V4.7c0-.7.5-1.2 1.2-1.2zM2.4 4.4 8 8.8l5.6-4.4',
  phone: 'M5.6 2.5H4a1.5 1.5 0 0 0-1.5 1.6C2.9 9.3 6.7 13.1 11.9 13.5a1.5 1.5 0 0 0 1.6-1.5v-1.6l-2.6-1.1-1.3 1.3a7.4 7.4 0 0 1-3.2-3.2l1.3-1.3z',
  file: 'M10.8 5.4 6.3 9.9a1.3 1.3 0 0 0 1.8 1.8l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.4 8a3.9 3.9 0 0 0 5.5 5.5l3.3-3.3',
  relation: 'M5 11 11 5M6.5 5H11v4.5',
  rollup: 'M3 3v3.5A3.5 3.5 0 0 0 6.5 10H13M10 7l3 3-3 3',
  formula: 'M11.5 3h-7l4 5-4 5h7',
  created_time: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.8V8l2.2 1.4',
  updated_time: 'M13.6 8A5.6 5.6 0 1 1 11.9 4M13.6 2.6V5h-2.4M8 5v3l2 1.3',
  plus: 'M8 3v10M3 8h10',
  filter: 'M2.5 4h11M4.5 8h7M6.5 12h3',
  sort: 'M5 3v10M2.5 10.5 5 13l2.5-2.5M11 13V3M8.5 5.5 11 3l2.5 2.5',
  group: 'M2.5 3.5h11M2.5 6.5h11M5 9.5h8.5M5 12.5h8.5',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  eyeOff: 'M2.5 2.5l11 11M6.6 4A6.6 6.6 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a12 12 0 0 1-1.7 2.2M10.9 10.9A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a12 12 0 0 1 2.6-3',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3 14 14',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.6a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8.6',
  copy: 'M6.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2',
  edit: 'M10.6 2.9a1.4 1.4 0 0 1 2 2L5.5 12 2.5 13l1-3z',
  open: 'M9 2.5h4.5V7M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3',
  peek: 'M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM9 2.5v11',
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  chevronLeft: 'M10 4 6 8l4 4',
  chevronUp: 'M4 10l4-4 4 4',
  grip: 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  close: 'M4 4l8 8M12 4l-8 8',
  check: 'M3.2 8.4l3 3 6.6-6.8',
  table: 'M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM2 6h12M2 9.8h12M6.5 6v7.5',
  board: 'M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v9h-3z',
  calendar: 'M3.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5V5a1.5 1.5 0 0 1 1.5-1.5zM2 7h12M5.5 2v3M10.5 2v3',
  gallery: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  timeline: 'M2.5 4h6M5 8h8.5M3.5 12h5.5',
  settings: 'M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 3v3M6 10v3',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
  image: 'M3 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM2 10.5l3.2-3 3 2.6 2-1.6 3.8 3M10.2 6.4h.01',
  link: 'M7 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7',
  page: 'M4 2h5.5L12.5 5v8a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM9.5 2v3h3',
  database: 'M8 2c3 0 5.5.9 5.5 2v8c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2V4c0-1.1 2.5-2 5.5-2zM2.5 4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2',
  wrap: 'M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8.5M10 10.5 8.5 12l1.5 1.5M2.5 12h3',
  calc: 'M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5.5 5h5M5.5 8.5h.01M8 8.5h.01M10.5 8.5h.01M5.5 11h.01M8 11h.01M10.5 11h.01',
  sparkle: 'M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z',
  title: '',
};

export type IconName = keyof typeof P | PropertyType | DbViewType;

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  if (name === 'title') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className={`db-icon ${className ?? ''}`} aria-hidden={!title} role={title ? 'img' : undefined}>
        {title && <title>{title}</title>}
        <text x="0.5" y="12.2" fontSize="10.5" fontWeight="650" fill="currentColor" fontFamily="inherit">Aa</text>
      </svg>
    );
  }
  const d = P[name] ?? P.text;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.45} strokeLinecap="round" strokeLinejoin="round"
      className={`db-icon ${className ?? ''}`} aria-hidden={!title} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
