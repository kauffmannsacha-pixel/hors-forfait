// Icônes au trait du module Claude (16 px, couleur = currentColor).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const mk = (paths: React.ReactNode) => ({ size = 16, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>{paths}</svg>
);

export const ISparkle = mk(<><path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>);
export const ISend = mk(<path d="M12 19V5M6 11l6-6 6 6" />);
export const IStop = ({ size = 16, ...rest }: P) => <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...rest}><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" /></svg>;
export const IPlus = mk(<path d="M12 5v14M5 12h14" />);
export const IChevron = mk(<path d="M6 9l6 6 6-6" />);
export const IChevronRight = mk(<path d="M9 6l6 6-6 6" />);
export const ICopy = mk(<><rect x="8.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" /></>);
export const IInsert = mk(<><path d="M12 4v10M7.5 9.5L12 14l4.5-4.5" /><path d="M5 19h14" /></>);
export const ITrash = mk(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>);
export const ICheck = mk(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IClose = mk(<path d="M6 6l12 12M18 6L6 18" />);
export const ITool = mk(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5v3h3l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />);
export const IPlug = mk(<><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z" /><path d="M12 16v5" /></>);
export const IRefresh = mk(<><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>);
export const IKey = mk(<><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></>);
export const IPage = mk(<><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M14 3v5h5" /></>);
export const ISelection = mk(<><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" /><path d="M8 10h8M8 14h5" /></>);
export const IClip = mk(<path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />);
export const IImage = mk(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 16l-5-5-8 8.5" /></>);
export const IHistory = mk(<><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4.5V9H8" /><path d="M12 8v4l3 2" /></>);
export const IGear = mk(<><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>);
export const IUndo = mk(<><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>);
export const IWarn = mk(<><path d="M12 3.5L2.5 20h19z" /><path d="M12 10v4.5M12 17.5h.01" /></>);
