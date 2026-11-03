// Popover flottant en verre : positionné près d'une ancre, reste dans la fenêtre, se ferme au clic extérieur / Échap.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type AnchorRect = { left: number; top: number; width: number; height: number };
export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start' | 'bottom';

export const toAnchor = (r: AnchorRect | Element | DOMRect): AnchorRect => {
  const b = r instanceof Element ? r.getBoundingClientRect() : r;
  return { left: b.left, top: b.top, width: b.width, height: b.height };
};
export const pointAnchor = (x: number, y: number): AnchorRect => ({ left: x, top: y, width: 0, height: 0 });

// Pile des popovers ouverts : Échap et clic extérieur ne ferment que le plus haut.
const stack: HTMLElement[] = [];
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

export function computePlacement(anchor: AnchorRect, w: number, h: number, placement: Placement, offset = 6, vw = window.innerWidth, vh = window.innerHeight) {
  const m = 8; let left: number; let top: number;
  if (placement === 'right-start' || placement === 'left-start') {
    left = placement === 'right-start' ? anchor.left + anchor.width + offset : anchor.left - w - offset;
    if (placement === 'right-start' && left + w > vw - m) left = anchor.left - w - offset;
    if (placement === 'left-start' && left < m) left = anchor.left + anchor.width + offset;
    top = anchor.top - 4;
  } else {
    const above = placement.startsWith('top');
    left = placement.endsWith('end') ? anchor.left + anchor.width - w : placement === 'bottom' ? anchor.left + anchor.width / 2 - w / 2 : anchor.left;
    top = above ? anchor.top - h - offset : anchor.top + anchor.height + offset;
    if (!above && top + h > vh - m && anchor.top - h - offset > m) top = anchor.top - h - offset;
    if (above && top < m) top = anchor.top + anchor.height + offset;
  }
  return { left: clamp(left, m, Math.max(m, vw - w - m)), top: clamp(top, m, Math.max(m, vh - h - m)) };
}

export interface PopoverProps {
  anchor: AnchorRect;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  style?: CSSProperties;
  offset?: number;
  /** Ne pas fermer au clic extérieur (ex. pendant un glisser). */
  modal?: boolean;
  role?: string;
  label?: string;
}

export function Popover({ anchor, onClose, children, placement = 'bottom-start', className = '', style, offset = 6, modal, role = 'dialog', label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const place = () => setPos(computePlacement(anchor, el.offsetWidth, el.offsetHeight, placement, offset));
    place();
    const ro = new ResizeObserver(place); ro.observe(el);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  }, [anchor.left, anchor.top, anchor.width, anchor.height, placement, offset]);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    stack.push(el);
    const isTop = () => stack[stack.length - 1] === el;
    const down = (e: PointerEvent) => {
      if (modal) return;
      const t = e.target as Node;
      const idx = stack.indexOf(el);
      if (stack.slice(idx).some(p => p.contains(t))) return; // dans ce popover ou un enfant
      if (isTop()) closeRef.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && isTop()) { e.preventDefault(); e.stopPropagation(); closeRef.current(); } };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      const i = stack.indexOf(el); if (i >= 0) stack.splice(i, 1);
    };
  }, [modal]);

  return createPortal(
    <div ref={ref} role={role} aria-label={label} className={`popover glass ${className}`}
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden', ...style }}
      onPointerDown={e => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}
