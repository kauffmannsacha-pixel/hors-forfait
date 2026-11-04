// Éléments partagés par les vues : API de vue, carte de ligne, couverture, menu de ligne, capteurs DnD.
import { KeyboardSensor, PointerSensor, useSensor, useSensors, type DropAnimation } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Page } from '../../db/types';
import { FILE_PIN_NODE } from '../../files/api';
import { CellValue, isImageRef, useFileUrl, youtubeThumb } from '../cells/CellView';
import { report } from '../cells/editors';
import { asFiles, asText, isEmptyValue, type EngineCtx } from '../engine';
import type { FileRef, PropDef, Schema, ViewX } from '../model';
import { duplicateRows, setValue, trashRows } from '../mutations';
import { Icon } from '../ui/icons';
import { Menu, MenuItem, MenuSep, Popover } from '../ui/Popover';

export interface NewRowInit { props?: Record<string, unknown>; title?: string; order?: number }
export interface DbViewApi {
  dbId: string; schema: Schema; view: ViewX; ctx: EngineCtx;
  /** Toutes les lignes vivantes (ordre manuel). */
  rows: Page[];
  /** Lignes filtrées, recherchées et triées. */
  visible: Page[];
  /** Propriétés visibles dans la vue (titre compris), dans l'ordre de la vue. */
  props: PropDef[];
  compact: boolean;
  /** Aucun tri actif : l'ordre manuel (glisser-déposer) s'applique. */
  manualOrder: boolean;
  update: (patch: Partial<ViewX> | ((v: ViewX) => Partial<ViewX>)) => void;
  newRow: (init?: NewRowInit) => Promise<Page | undefined>;
  open: (rowId: string) => void;
  peek: (rowId: string) => void;
  /** Ouvre le menu d'une propriété (renommer, type…). */
  editProp: (propId: string, anchor: HTMLElement) => void;
  /** Id d'une ligne tout juste créée dont on édite le titre. */
  editingTitle: string | null;
  setEditingTitle: (id: string | null) => void;
}

export function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}
/** Retour « ressort » sans rebond à la fin d'un glisser-déposer. */
export const dropAnimation: DropAnimation = { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1)' };

// ── Couvertures ──────────────────────────────────────────────
export type CoverSrc = { ref: FileRef } | { css: string } | null;
function firstImage(node: unknown): FileRef | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  if (n.type === 'image' && typeof n.attrs?.src === 'string') return { url: n.attrs.src, name: 'image' };
  if (n.type === FILE_PIN_NODE && typeof n.attrs?.hash === 'string' && String(n.attrs?.mime ?? '').startsWith('image/')) return { hash: n.attrs.hash as string, name: String(n.attrs.name ?? 'image'), mime: String(n.attrs.mime) };
  if (Array.isArray(n.content)) for (const c of n.content) { const r = firstImage(c); if (r) return r; }
  return null;
}
export function coverOf(row: Page, view: ViewX, schema: Schema): CoverSrc {
  const mode = view.cover ?? (view.type === 'gallery' ? 'page' : 'none');
  if (mode === 'none') return null;
  if (mode === 'page') {
    const c = row.cover?.trim();
    if (c) {
      if (/^[a-f0-9]{64}$/i.test(c)) return { ref: { hash: c, name: 'couverture' } };
      if (/^(https?:|data:|asset:|blob:|tauri:|\/)/i.test(c)) return { ref: { url: c, name: 'couverture' } };
      if (/gradient\(|^#|^rgb|^hsl/i.test(c)) return { css: c };
    }
    const img = firstImage(row.content);
    return img ? { ref: img } : null;
  }
  const p = schema.properties.find(x => x.id === mode);
  if (!p) return null;
  if (p.type === 'file') { const f = asFiles(row.props?.[p.id]).find(isImageRef); return f ? { ref: f } : null; }
  if (p.type === 'url') {
    const u = asText(row.props?.[p.id]);
    const yt = u ? youtubeThumb(u) : null;
    if (yt) return { ref: { url: yt, name: 'miniature' } };
    if (u && isImageRef({ url: u, name: u })) return { ref: { url: u, name: u } };
  }
  return null;
}
export function CoverView({ src, fit, className = '' }: { src: CoverSrc; fit?: boolean; className?: string }) {
  const url = useFileUrl(src && 'ref' in src ? src.ref : null);
  if (!src) return null;
  if ('css' in src) return <div className={`db-cover ${className}`} style={{ background: src.css }} />;
  return (
    <div className={`db-cover ${className}`}>
      {url ? <img src={url} alt="" draggable={false} style={{ objectFit: fit ? 'contain' : 'cover' }} /> : <div className="db-cover-ph"><Icon name="image" size={20} /></div>}
    </div>
  );
}

// ── Menu de ligne ────────────────────────────────────────────
export function RowMenu({ api, row, anchor, onClose }: { api: DbViewApi; row: Page; anchor: HTMLElement | null; onClose: () => void }) {
  return (
    <Popover open={!!anchor} anchor={anchor} onClose={onClose} width={220} label="Actions de la ligne">
      <Menu autoFocus>
        <MenuItem icon="open" label="Ouvrir en pleine page" onSelect={() => { onClose(); api.open(row.id); }} />
        <MenuItem icon="peek" label="Aperçu" onSelect={() => { onClose(); api.peek(row.id); }} />
        <MenuItem icon="copy" label="Dupliquer" onSelect={() => { onClose(); void duplicateRows([row.id]).catch(report); }} />
        <MenuSep />
        <MenuItem icon="trash" danger label="Supprimer" onSelect={() => { onClose(); void trashRows([row.id]).catch(report); }} />
      </Menu>
    </Popover>
  );
}

/** Titre modifiable en place (nouvelle carte). Entrée valide ; Échap sur une carte vide la supprime. */
export function InlineTitle({ row, onDone, placeholder = 'Sans titre' }: { row: Page; onDone: () => void; placeholder?: string }) {
  const [v, setV] = useState(row.title);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); }, []);
  const commit = (keep = true) => {
    if (done.current) return; done.current = true;
    const titleProp: PropDef = { id: 'title', name: 'Titre', type: 'title' };
    if (!keep && !v.trim() && !Object.keys(row.props ?? {}).length) void trashRows([row.id]);
    else if (v !== row.title) void setValue(row.id, titleProp, v).catch(report);
    onDone();
  };
  return (
    <input ref={ref} className="db-inline-title" value={v} placeholder={placeholder} aria-label="Titre"
      onChange={e => setV(e.target.value)} onBlur={() => commit(true)} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); }} />
  );
}

// ── Carte (board, galerie, calendrier) ──────────────────────
export function RowCard({ api, row, cover, compact, style, className = '', dragHandle, lifted, onClick }: {
  api: DbViewApi; row: Page; cover?: boolean; compact?: boolean; style?: CSSProperties; className?: string;
  dragHandle?: Record<string, unknown>; lifted?: boolean; onClick?: () => void;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const editing = api.editingTitle === row.id;
  const shown = api.props.filter(p => p.id !== 'title' && !isEmptyValue(row, p, api.ctx));
  const src = cover ? coverOf(row, api.view, api.schema) : null;
  return (
    <div className={`db-card${lifted ? ' lifted' : ''}${compact ? ' compact' : ''} ${className}`} style={style} {...dragHandle}
      role="button" tabIndex={0} aria-label={row.title || 'Sans titre'}
      onClick={() => { if (!editing) (onClick ?? (() => api.open(row.id)))(); }}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) api.open(row.id); }}>
      {src && <CoverView src={src} fit={api.view.fitImage} className={`db-card-cover size-${api.view.cardSize ?? 'medium'}`} />}
      <div className="db-card-body">
        <div className="db-card-title">
          {row.icon && <span className="db-row-icon">{row.icon}</span>}
          {editing ? <InlineTitle row={row} onDone={() => api.setEditingTitle(null)} /> : row.title ? <span>{row.title}</span> : <span className="db-placeholder">Sans titre</span>}
        </div>
        {!compact && shown.length > 0 && (
          <div className="db-card-props">
            {shown.map(p => <div key={p.id} className={`db-card-prop db-cp-${p.type}`} title={p.name}><CellValue row={row} prop={p} ctx={api.ctx} variant="card" /></div>)}
          </div>
        )}
      </div>
      {!lifted && (
        <div className="db-card-actions" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
          <button type="button" className="db-icon-btn" title="Aperçu" aria-label="Aperçu" onClick={() => api.peek(row.id)}><Icon name="peek" /></button>
          <button type="button" className="db-icon-btn" title="Actions" aria-label="Actions" onClick={e => setMenu(e.currentTarget)}><Icon name="more" /></button>
        </div>
      )}
      {menu && <RowMenu api={api} row={row} anchor={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function ViewEmpty({ icon, title, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; children?: ReactNode }) {
  return (
    <div className="db-view-empty">
      <span className="db-view-empty-ico"><Icon name={icon} size={22} /></span>
      <div className="db-view-empty-title">{title}</div>
      {children}
    </div>
  );
}
