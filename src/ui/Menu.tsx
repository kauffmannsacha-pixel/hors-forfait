// Menu contextuel en verre (navigation clavier, sous-menus) + API impérative openMenu().
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Popover, toAnchor, type AnchorRect, type Placement } from './Popover';
import { IconCheck, IconChevronRight } from './icons';

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  /** Titre de section (non cliquable). */
  heading?: boolean;
  submenu?: MenuItem[];
  onSelect?: () => void | Promise<void>;
}

interface MenuProps { anchor: AnchorRect; items: MenuItem[]; onClose: () => void; placement?: Placement; minWidth?: number; className?: string; onDone?: () => void }

const selectable = (it: MenuItem) => !it.separator && !it.heading && !it.disabled;

export function Menu({ anchor, items, onClose, placement = 'bottom-start', minWidth = 220, className = '', onDone }: MenuProps) {
  const [active, setActive] = useState(() => items.findIndex(selectable));
  const [sub, setSub] = useState<{ index: number; anchor: AnchorRect } | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const hoverTimer = useRef<number>(0);
  const finish = onDone ?? onClose;

  const openSub = (i: number) => {
    const el = rowRefs.current[i]; if (!el || !items[i]?.submenu) return;
    setSub({ index: i, anchor: toAnchor(el) });
  };
  const run = async (i: number) => {
    const it = items[i]; if (!it || !selectable(it)) return;
    if (it.submenu) { openSub(i); return; }
    finish();
    await it.onSelect?.();
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (sub) return; // le sous-menu gère le clavier
      const move = (d: number) => {
        if (!items.some(selectable)) return;
        let i = active;
        do { i = (i + d + items.length) % items.length; } while (!selectable(items[i]));
        setActive(i); rowRefs.current[i]?.scrollIntoView({ block: 'nearest' });
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void run(active); }
      else if (e.key === 'ArrowRight' && items[active]?.submenu) { e.preventDefault(); e.stopPropagation(); openSub(active); }
      else if (e.key === 'ArrowLeft' && placement === 'right-start') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement} className={`menu ${className}`} role="menu" style={{ minWidth }}>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-sep" role="separator" />;
        if (it.heading) return <div key={i} className="menu-heading">{it.label}</div>;
        return (
          <button key={i} ref={el => { rowRefs.current[i] = el; }} type="button" role="menuitem"
            className={`menu-item${i === active ? ' active' : ''}${it.danger ? ' danger' : ''}`} disabled={it.disabled}
            onPointerEnter={() => {
              setActive(i); window.clearTimeout(hoverTimer.current);
              if (it.submenu) hoverTimer.current = window.setTimeout(() => openSub(i), 120);
              else if (sub) hoverTimer.current = window.setTimeout(() => setSub(null), 150);
            }}
            onClick={() => void run(i)}>
            <span className="menu-icon">{it.checked ? <IconCheck /> : it.icon}</span>
            <span className="menu-label">{it.label}{it.hint && <span className="menu-hint">{it.hint}</span>}</span>
            {it.shortcut && <kbd className="menu-kbd">{it.shortcut}</kbd>}
            {it.submenu && <IconChevronRight size={14} className="menu-chev" />}
          </button>
        );
      })}
      {sub && items[sub.index]?.submenu && (
        <Menu anchor={sub.anchor} items={items[sub.index].submenu as MenuItem[]} placement="right-start" minWidth={200}
          onClose={() => setSub(null)} onDone={finish} />
      )}
    </Popover>
  );
}

// ── API impérative ──
interface OpenMenu { anchor: AnchorRect; items: MenuItem[]; placement?: Placement; minWidth?: number; onClose?: () => void; key: number }
const useMenuStore = create<{ menu: OpenMenu | null }>(() => ({ menu: null }));
let seq = 0;

/** Ouvre un menu contextuel ancré sur un élément / rectangle. */
export function openMenu(anchor: AnchorRect | Element | DOMRect, items: MenuItem[], opts: { placement?: Placement; minWidth?: number; onClose?: () => void } = {}) {
  const prev = useMenuStore.getState().menu; prev?.onClose?.();
  useMenuStore.setState({ menu: { anchor: toAnchor(anchor), items, ...opts, key: ++seq } });
}
export const closeMenu = () => { const m = useMenuStore.getState().menu; useMenuStore.setState({ menu: null }); m?.onClose?.(); };
export const isMenuOpen = () => useMenuStore.getState().menu !== null;

/** À monter une fois (coque) : affiche le menu ouvert par openMenu(). */
export function MenuHost() {
  const menu = useMenuStore(s => s.menu);
  const items = useMemo(() => menu?.items ?? [], [menu]);
  if (!menu) return null;
  return <Menu key={menu.key} anchor={menu.anchor} items={items} placement={menu.placement} minWidth={menu.minWidth} onClose={closeMenu} />;
}
