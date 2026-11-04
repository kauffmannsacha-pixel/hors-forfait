// Popovers / menus « Liquid Glass » : portail, positionnement anti-débordement, pile (popovers imbriqués),
// fermeture au clic extérieur / Échap, animation à ressort (sans rebond) interruptible.
import { AnimatePresence, motion } from 'motion/react';
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';

export type Anchor = HTMLElement | DOMRect | { x: number; y: number } | null | undefined;
export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'right-start' | 'cover';

interface StackEntry { id: number; el: () => HTMLElement | null; anchor: () => Anchor; close: () => void }
const stack: StackEntry[] = [];
let seq = 0;
let installed = false;

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerdown', e => {
    const t = e.target as Node | null;
    if (!t || !stack.length) return;
    const toClose: StackEntry[] = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i];
      if (s.el()?.contains(t)) break;
      const a = s.anchor();
      if (a instanceof HTMLElement && a.contains(t)) break;
      toClose.push(s);
    }
    toClose.forEach(s => s.close());
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !stack.length) return;
    e.stopPropagation(); e.preventDefault();
    stack[stack.length - 1].close();
  }, true);
}
/** true si un popover du module est ouvert (pour ne pas fermer un panneau parent sur Échap). */
export const popoverOpen = () => stack.length > 0;

function rectOf(a: Anchor): DOMRect | null {
  if (!a) return null;
  if (a instanceof HTMLElement) return a.isConnected ? a.getBoundingClientRect() : null;
  if (a instanceof DOMRect) return a;
  return new DOMRect(a.x, a.y, 0, 0);
}

export interface PopoverProps {
  open: boolean; onClose: () => void; anchor: Anchor; children: ReactNode;
  placement?: Placement; offset?: number; className?: string; width?: number; minWidth?: number; maxHeight?: number;
  matchAnchorWidth?: boolean; style?: CSSProperties; label?: string;
}

export function Popover({ open, onClose, anchor, children, placement = 'bottom-start', offset = 6, className = '', width, minWidth, maxHeight, matchAnchorWidth, style, label }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; w?: number; origin: string } | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const anchorRef = useRef(anchor); anchorRef.current = anchor;

  const place = useCallback(() => {
    const el = ref.current; const r = rectOf(anchorRef.current);
    if (!el || !r) return;
    const vw = window.innerWidth, vh = window.innerHeight, m = 8;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = r.left, top = r.bottom + offset, origin = 'top left';
    switch (placement) {
      case 'bottom-end': left = r.right - w; origin = 'top right'; break;
      case 'top-start': top = r.top - offset - h; origin = 'bottom left'; break;
      case 'right-start': left = r.right + offset; top = r.top - 6; break;
      case 'cover': left = r.left - 1; top = r.top - 1; break;
    }
    if (placement === 'right-start' && left + w > vw - m) left = Math.max(m, r.left - offset - w);
    if (placement !== 'cover' && placement !== 'top-start' && top + h > vh - m && r.top - offset - h > m) { top = r.top - offset - h; origin = origin.replace('top', 'bottom'); }
    if (placement === 'top-start' && top < m) top = r.bottom + offset;
    left = Math.min(Math.max(m, left), Math.max(m, vw - w - m));
    top = Math.min(Math.max(m, top), Math.max(m, vh - h - m));
    setPos(p => (p && Math.abs(p.left - left) < .5 && Math.abs(p.top - top) < .5 && p.w === r.width ? p : { left, top, w: r.width, origin }));
  }, [placement, offset]);

  useLayoutEffect(() => { if (open) place(); else setPos(null); }, [open, place, anchor]);
  useEffect(() => {
    if (!open) return;
    install();
    const entry: StackEntry = { id: ++seq, el: () => ref.current, anchor: () => anchorRef.current, close: () => closeRef.current() };
    stack.push(entry);
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onMove) : null;
    if (ref.current && ro) ro.observe(ref.current);
    return () => {
      const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      ro?.disconnect();
    };
  }, [open, place]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="dialog" aria-label={label}
          className={`db-pop ${className}`}
          style={{
            left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden', transformOrigin: pos?.origin,
            width: width ?? (matchAnchorWidth || placement === 'cover' ? Math.max(pos?.w ?? 0, minWidth ?? 0) + 2 : undefined),
            minWidth, maxHeight, ...style,
          }}
          initial={{ opacity: 0, scale: 0.96, y: placement === 'cover' ? 0 : -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
          transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          onContextMenu={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Popover piloté par un bouton : renvoie [ancre, ouvert, ouvrir/fermer]. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const ref = useRef<T | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return { ref, open, setOpen, toggle, close };
}

// ── Menus ────────────────────────────────────────────────────
function moveFocus(container: HTMLElement, dir: 1 | -1) {
  const items = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]),[role="menuitemcheckbox"]:not([disabled]),[role="option"]')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  items[(i + dir + items.length) % items.length]?.focus();
}
export function Menu({ children, className = '', autoFocus = false }: { children: ReactNode; className?: string; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [autoFocus]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(ref.current!, 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(ref.current!, -1); }
  };
  return <div ref={ref} role="menu" className={`db-menu ${className}`} onKeyDown={onKey}>{children}</div>;
}

export function MenuItem({ icon, label, hint, right, danger, active, disabled, onSelect, checked, title }: {
  icon?: IconName | ReactNode; label: ReactNode; hint?: ReactNode; right?: ReactNode; danger?: boolean; active?: boolean;
  disabled?: boolean; checked?: boolean; onSelect?: (e: React.MouseEvent<HTMLButtonElement>) => void; title?: string;
}) {
  return (
    <button type="button" role={checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={checked} title={title}
      className={`db-menu-item${danger ? ' danger' : ''}${active ? ' active' : ''}`} disabled={disabled} onClick={onSelect}>
      {icon !== undefined && <span className="db-menu-icon">{typeof icon === 'string' ? <Icon name={icon as IconName} /> : icon}</span>}
      <span className="db-menu-label-text">{label}</span>
      {hint && <span className="db-menu-hint">{hint}</span>}
      {right}
      {checked && <Icon name="check" className="db-menu-check" />}
    </button>
  );
}
export const MenuSep = () => <div className="db-menu-sep" role="separator" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="db-menu-label">{children}</div>;

/** Petit interrupteur iOS. */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`db-switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="db-switch-knob" />
    </button>
  );
}
