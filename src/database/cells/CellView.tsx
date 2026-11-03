// Rendu en lecture des valeurs de cellules, pour chaque type de propriété.
import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '../../db/store';
import type { Page } from '../../db/types';
import { files } from '../../files/api';
import { openPage } from '../../ui/appState';
import { formatDateRange, formatTimestamp, readDate } from '../dates';
import {
  asBool, asFiles, asList, asNumber, asText, computed, formatFValue, formatNumber, optionFor, optionsFor, personFor,
  rawValue, relationIds, rollupNumberProp, type EngineCtx,
} from '../engine';
import type { FValue } from '../formula';
import { colorOf, type FileRef, type Person, type PropDef } from '../model';
import { Icon } from '../ui/icons';

// ── Ouverture externe ────────────────────────────────────────
export const normalizeUrl = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u.trim()) ? u.trim() : `https://${u.trim()}`);
export async function openExternal(url: string) {
  if (isTauri) {
    try { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); return; } catch { /* repli navigateur */ }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ── Fichiers ─────────────────────────────────────────────────
const urlCache = new Map<string, string | null>();
export const isImageRef = (f: FileRef) => (f.mime ? f.mime.startsWith('image/') : /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i.test(f.url ?? f.name));
export function youtubeThumb(url: string): string | null {
  const id = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(url)?.[1];
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
/** URL affichable d'un fichier (vault → convertFileSrc, ou lien). */
export function useFileUrl(f: FileRef | null | undefined): string | null {
  const key = f ? f.hash ?? f.url ?? '' : '';
  const [url, setUrl] = useState<string | null>(() => (f?.url ? normalizeUrl(f.url) : (f?.hash && urlCache.get(f.hash)) || null));
  useEffect(() => {
    if (!f) { setUrl(null); return; }
    if (f.url) { setUrl(normalizeUrl(f.url)); return; }
    const hash = f.hash; if (!hash) { setUrl(null); return; }
    if (urlCache.has(hash)) { setUrl(urlCache.get(hash) ?? null); return; }
    let live = true;
    files.get(hash).then(vf => { const u = vf ? files.url(vf) : null; urlCache.set(hash, u); if (live) setUrl(u); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}
export function openFile(f: FileRef) {
  if (f.hash) void files.open(f.hash, 'panel').catch(() => files.open(f.hash!, 'system').catch(() => undefined));
  else if (f.url) void openExternal(normalizeUrl(f.url));
}

// ── Petits éléments ──────────────────────────────────────────
export function Tag({ name, color, dot, onRemove, title }: { name: ReactNode; color?: string; dot?: boolean; onRemove?: () => void; title?: string }) {
  return (
    <span className={`db-tag db-c-${colorOf(color)}${dot ? ' db-tag-status' : ''}`} title={title}>
      {dot && <span className="db-dot" />}
      <span className="db-tag-text">{name}</span>
      {onRemove && (
        <button type="button" className="db-tag-x" aria-label="Retirer" onClick={e => { e.stopPropagation(); onRemove(); }}>
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
export function Avatar({ person, size = 20 }: { person: Person; size?: number }) {
  return <span className={`db-avatar db-c-${colorOf(person.color)}`} style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden>{initials(person.name)}</span>;
}
export function PersonChip({ person, onRemove }: { person: Person; onRemove?: () => void }) {
  return (
    <span className="db-person" title={person.email ?? person.name}>
      <Avatar person={person} /><span className="db-person-name">{person.name}</span>
      {onRemove && <button type="button" className="db-tag-x" aria-label="Retirer" onClick={e => { e.stopPropagation(); onRemove(); }}><Icon name="close" size={10} /></button>}
    </span>
  );
}
export function FileChip({ file, onRemove, thumb = true }: { file: FileRef; onRemove?: () => void; thumb?: boolean }) {
  const url = useFileUrl(thumb && isImageRef(file) ? file : null);
  return (
    <span className="db-file" title={file.name} onClick={e => { e.stopPropagation(); openFile(file); }}>
      {url ? <img src={url} alt="" className="db-file-thumb" draggable={false} /> : <Icon name="file" size={13} />}
      <span className="db-file-name">{file.name}</span>
      {onRemove && <button type="button" className="db-tag-x" aria-label="Retirer" onClick={e => { e.stopPropagation(); onRemove(); }}><Icon name="close" size={10} /></button>}
    </span>
  );
}
export function RelationChip({ page, onRemove }: { page: Page | undefined; onRemove?: () => void }) {
  if (!page) return null;
  return (
    <span className="db-rel" onClick={e => { e.stopPropagation(); openPage(page.id); }} title="Ouvrir la page">
      <span className="db-rel-icon">{page.icon ?? <Icon name="page" size={13} />}</span>
      <span className="db-rel-name">{page.title || 'Sans titre'}</span>
      {onRemove && <button type="button" className="db-tag-x" aria-label="Retirer" onClick={e => { e.stopPropagation(); onRemove(); }}><Icon name="close" size={10} /></button>}
    </span>
  );
}
export function CheckboxView({ checked, size = 16 }: { checked: boolean; size?: number }) {
  return (
    <span className={`db-check${checked ? ' on' : ''}`} style={{ width: size, height: size }} aria-hidden>
      {checked && <Icon name="check" size={size - 3} />}
    </span>
  );
}
function NumberBar({ value, prop }: { value: number; prop: PropDef }) {
  const max = prop.divideBy || 100;
  const r = Math.max(0, Math.min(1, value / max));
  if (prop.showAs === 'ring') {
    const c = 2 * Math.PI * 6;
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" className="db-ring" aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray={`${c * r} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
      </svg>
    );
  }
  return <span className="db-bar" aria-hidden><span style={{ width: `${r * 100}%` }} /></span>;
}

function FormulaView({ v, numberProp, error }: { v: FValue; numberProp?: PropDef; error?: string }) {
  if (error) return <span className="db-ferr" title={error}><Icon name="formula" size={12} /> Erreur</span>;
  if (typeof v === 'boolean') return <CheckboxView checked={v} />;
  if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) {
    return <span className="db-tags">{(v as string[]).map((x, i) => <Tag key={i} name={x} />)}</span>;
  }
  const t = formatFValue(v, numberProp);
  return t ? <span className={typeof v === 'number' ? 'db-num' : undefined}>{t}</span> : null;
}

export type Variant = 'table' | 'card' | 'row' | 'list';

/** Valeur affichée d'une cellule. */
export function CellValue({ row, prop, ctx }: { row: Page; prop: PropDef; ctx: EngineCtx; variant?: Variant }) {
  const raw = rawValue(row, prop);
  switch (prop.type) {
    case 'title':
      return (
        <span className="db-title-val">
          {row.icon && <span className="db-row-icon">{row.icon}</span>}
          {row.title ? <span className="db-title-text">{row.title}</span> : <span className="db-placeholder">Sans titre</span>}
        </span>
      );
    case 'text': { const t = asText(raw); return t ? <span className="db-text">{t}</span> : null; }
    case 'number': {
      const n = asNumber(raw); if (n === null) return null;
      return (
        <span className={`db-num${prop.showAs && prop.showAs !== 'number' ? ' db-num-bar' : ''}`}>
          {prop.showAs && prop.showAs !== 'number' && <NumberBar value={n} prop={prop} />}
          {formatNumber(n, prop)}
        </span>
      );
    }
    case 'select': case 'status': {
      const o = optionFor(prop, raw); return o ? <Tag name={o.name} color={o.color} dot={prop.type === 'status'} /> : null;
    }
    case 'multi_select': {
      const os = optionsFor(prop, raw); if (!os.length) return null;
      return <span className="db-tags">{os.map(o => <Tag key={o.id + o.name} name={o.name} color={o.color} />)}</span>;
    }
    case 'date': {
      const r = readDate(raw); if (!r) return null;
      return <span className="db-date">{formatDateRange(r, prop.dateFormat, prop.timeFormat, ctx.now)}</span>;
    }
    case 'person': {
      const ids = asList(raw); if (!ids.length) return null;
      return <span className="db-tags">{ids.map(id => <PersonChip key={id} person={personFor(ctx, id)} />)}</span>;
    }
    case 'checkbox': return <CheckboxView checked={asBool(raw)} />;
    case 'url': case 'email': case 'phone': {
      const t = asText(raw); if (!t) return null;
      const href = prop.type === 'email' ? `mailto:${t}` : prop.type === 'phone' ? `tel:${t.replace(/\s/g, '')}` : normalizeUrl(t);
      const label = prop.type === 'url' ? t.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : t;
      return (
        <a className="db-link" href={href} title={t} onClick={e => { e.preventDefault(); e.stopPropagation(); void openExternal(href); }}>
          {label}
        </a>
      );
    }
    case 'file': {
      const fs = asFiles(raw); if (!fs.length) return null;
      return <span className="db-tags">{fs.map((f, i) => <FileChip key={(f.hash ?? f.url ?? '') + i} file={f} />)}</span>;
    }
    case 'relation': {
      const ids = relationIds(row, prop, ctx); if (!ids.length) return null;
      return <span className="db-tags">{ids.map(id => <RelationChip key={id} page={ctx.getPage(id)} />)}</span>;
    }
    case 'formula': case 'rollup': {
      const c = computed(row, prop, ctx);
      return 'error' in c ? <FormulaView v={null} error={c.error} /> : <FormulaView v={c.value} numberProp={prop.type === 'rollup' ? rollupNumberProp(prop, ctx) : prop} />;
    }
    case 'created_time': case 'updated_time':
      return <span className="db-date">{formatTimestamp(Number(raw), prop.dateFormat, prop.timeFormat)}</span>;
  }
  return null;
}
