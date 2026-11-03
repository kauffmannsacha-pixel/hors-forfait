// Icônes au trait (style SF Symbols), 16 px par défaut, couleur = currentColor.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
});
const mk = (paths: React.ReactNode) => ({ size, ...rest }: P) => <svg {...base(size)} {...rest}>{paths}</svg>;

export const IconChevronRight = mk(<path d="M9 6l6 6-6 6" />);
export const IconChevronDown = mk(<path d="M6 9l6 6 6-6" />);
export const IconChevronLeft = mk(<path d="M15 6l-6 6 6 6" />);
export const IconPlus = mk(<path d="M12 5v14M5 12h14" />);
export const IconSearch = mk(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>);
export const IconSettings = mk(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const IconTrash = mk(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>);
export const IconStar = mk(<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />);
export const IconStarFilled = ({ size, ...rest }: P) => <svg {...base(size)} {...rest} fill="currentColor"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>;
export const IconClock = mk(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IconHistory = mk(<><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4.5V9H8" /><path d="M12 8v4l3 2" /></>);
export const IconMore = mk(<><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></>);
export const IconSidebar = mk(<><rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M9.5 4.5v15" /></>);
export const IconPage = mk(<><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M14 3v5h5" /></>);
export const IconArrowLeft = mk(<path d="M19 12H5M11 18l-6-6 6-6" />);
export const IconArrowRight = mk(<path d="M5 12h14M13 6l6 6-6 6" />);
export const IconClose = mk(<path d="M6 6l12 12M18 6L6 18" />);
export const IconCheck = mk(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconDownload = mk(<><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 19h14" /></>);
export const IconUpload = mk(<><path d="M12 16V5M7 10l5-5 5 5" /><path d="M5 19h14" /></>);
export const IconTemplate = mk(<><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M3.5 9h17M9 9v11.5" /></>);
export const IconCopy = mk(<><rect x="8.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" /></>);
export const IconLink = mk(<><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>);
export const IconGrip = ({ size, ...rest }: P) => <svg {...base(size)} {...rest} stroke="none" fill="currentColor">{[6, 12, 18].map(y => <g key={y}><circle cx="9" cy={y} r="1.5" /><circle cx="15" cy={y} r="1.5" /></g>)}</svg>;
export const IconRestore = mk(<><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4v4.5h4.5" /></>);
export const IconExternal = mk(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>);
export const IconSun = mk(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></>);
export const IconMoon = mk(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />);
export const IconMonitor = mk(<><rect x="3" y="4" width="18" height="12" rx="2.5" /><path d="M8 20h8M12 16v4" /></>);
export const IconSparkles = mk(<><path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>);
export const IconImport = mk(<><path d="M12 3v12M7 10l5 5 5-5" /><rect x="3.5" y="15" width="17" height="6" rx="2" /></>);
export const IconExpand = mk(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />);
export const IconFile = mk(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
export const IconCommand = mk(<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />);
export const IconKeyboard = mk(<><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>);
export const IconPalette = mk(<><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.6-1.8 0-1.2-.9-1.7-.9-2.8 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" /><circle cx="10" cy="7" r="1" fill="currentColor" /><circle cx="15" cy="7" r="1" fill="currentColor" /></>);
export const IconDatabase = mk(<><ellipse cx="12" cy="5.5" rx="7.5" ry="3" /><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" /></>);
export const IconBold = mk(<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />);
export const IconItalic = mk(<path d="M14 5h-4M14 19h-4M14.5 5l-5 14" />);
export const IconUnderline = mk(<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />);
export const IconStrike = mk(<><path d="M5 12h14" /><path d="M16.5 6.5C15.6 5 14 4.5 12 4.5c-2.6 0-4.5 1.3-4.5 3.3 0 1.4 1 2.4 3.3 3M8 17.5c.9 1.4 2.4 2 4.3 2 2.7 0 4.7-1.3 4.7-3.5 0-.9-.3-1.7-1-2.3" /></>);
export const IconCode = mk(<path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />);
export const IconHighlight = mk(<><path d="M5 20h14" /><path d="M14.5 4.5l5 5L11 18H6v-5z" /></>);
export const IconTextColor = mk(<><path d="M6 17L12 4l6 13M8.3 12.5h7.4" /></>);
export const IconTable = mk(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M3.5 15h17M10 4.5v15" /></>);
export const IconEye = mk(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>);
