// Composants partagés du miniatureur.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Empty, Sheet, SourceCite, Spinner } from '../../../ui/kit';
import { files } from '../../../files/api';
import type { VaultFile } from '../../../db/types';
import { imageFromDataTransfer, isImageMime } from '../lib/browserImage';
import { b64ToBytes } from '../lib/raster';
import type { PaletteColor } from '../lib/kmeans';
import { FAMILY_SWATCH, type ColorFamily } from '../lib/color';

export function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode; title?: string }[]; label?: string }) {
  return <div className="th-seg" role="group" aria-label={label}>{options.map(o => <button key={o.id} type="button" title={o.title} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>;
}
export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return <label className="th-check" style={disabled ? { opacity: 0.5 } : undefined}><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />{label}</label>;
}
export function Range({ label, value, min, max, step = 1, onChange, format }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return <label className="th-range"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /><span className="th-val">{format ? format(value) : Math.round(value)}</span></label>;
}
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return <label className="th-color"><span>{label}</span><input type="color" value={hex} onChange={e => onChange(e.target.value)} /><span className="th-muted th-num">{hex.toUpperCase()}</span></label>;
}
/** Barre de note /10 (texte en encre neutre, la couleur ne porte que le niveau). */
export function Meter({ label, value, max = 10, hint }: { label: string; value: number; max?: number; hint?: string }) {
  const r = Math.max(0, Math.min(1, value / max));
  const c = r >= 0.75 ? 'var(--good)' : r >= 0.5 ? 'var(--warn)' : 'var(--bad)';
  return <div className="th-meter" title={hint}><span>{label}</span><div className="th-track"><div className="th-fill" style={{ width: `${r * 100}%`, background: c }} /></div><span className="th-v">{value.toFixed(1).replace('.', ',')}</span></div>;
}
export function PaletteBar({ palette, legend = true }: { palette: PaletteColor[]; legend?: boolean }) {
  return <div>
    <div className="th-palette" role="img" aria-label={'Palette : ' + palette.map(p => `${p.name} ${Math.round(p.share * 100)} %`).join(', ')}>
      {palette.map(p => <div key={p.hex} style={{ width: `${p.share * 100}%`, background: p.hex }} title={`${p.name} · ${p.hex} · ${Math.round(p.share * 100)} %`} />)}
    </div>
    {legend && <div className="th-palette-legend">{palette.map(p => <span key={p.hex}><i className="th-sw" style={{ background: p.hex }} />{p.name} {Math.round(p.share * 100)} %</span>)}</div>}
  </div>;
}
export const Swatches = ({ palette, max = 5 }: { palette: PaletteColor[]; max?: number }) =>
  <span className="th-swatches">{palette.slice(0, max).map(p => <i key={p.hex} className="th-sw" style={{ background: p.hex }} title={`${p.name} ${Math.round(p.share * 100)} %`} />)}</span>;
export const FamilyDot = ({ family }: { family: ColorFamily }) => <i className="th-sw" style={{ background: FAMILY_SWATCH[family] }} />;

export function useObjectUrl(blob?: Blob | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => { if (!blob) { setUrl(undefined); return; } const u = URL.createObjectURL(blob); setUrl(u); return () => URL.revokeObjectURL(u); }, [blob]);
  return url;
}
/** URL affichable d'un fichier du vault. */
export function useVaultUrl(hash?: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let alive = true; setUrl(undefined);
    if (hash) files.get(hash).then(f => { if (alive && f) setUrl(files.url(f)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [hash]);
  return url;
}

/** Carte de saillance (48×27) en surcouche chaude, une seule teinte dont l'opacité suit l'intensité. */
export function SaliencyOverlay({ saliency }: { saliency: { w: number; h: number; b64: string } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const bytes = b64ToBytes(saliency.b64);
    const img = ctx.createImageData(saliency.w, saliency.h);
    for (let i = 0; i < bytes.length; i++) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 120; img.data[i * 4 + 2] = 40; img.data[i * 4 + 3] = Math.round(255 * Math.pow(bytes[i] / 255, 1.4)); }
    ctx.putImageData(img, 0, 0);
  }, [saliency]);
  return <canvas ref={ref} className="th-heat" width={saliency.w} height={saliency.h} aria-hidden />;
}
export const FocalMarker = ({ x, y, vision }: { x: number; y: number; vision?: boolean }) =>
  <span className={'th-focal' + (vision ? ' vision' : '')} style={{ left: `${x * 100}%`, top: `${y * 100}%` }} title={vision ? 'Point focal selon Claude' : 'Point focal mesuré (saillance)'} />;

export function DropZone({ onFile, title, hint, compact }: { onFile: (f: File) => void; title: string; hint?: string; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return <div className={'th-drop' + (over ? ' over' : '')} role="button" tabIndex={0} style={compact ? { padding: '14px 12px' } : undefined}
    onClick={() => input.current?.click()} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
    onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
    onDrop={e => { e.preventDefault(); setOver(false); const f = imageFromDataTransfer(e.dataTransfer); if (f) onFile(f); }}>
    {!compact && <div className="th-drop-icon" aria-hidden>🖼️</div>}
    <div className="th-strong">{title}</div>
    {hint && <div className="th-muted th-small">{hint}</div>}
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
  </div>;
}

/** Choix d'une image du vault. */
export function VaultPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (f: VaultFile) => void }) {
  const [list, setList] = useState<VaultFile[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open) return;
    setList(null);
    files.list().then(all => setList(all.filter(f => isImageMime(f.mime) && !f.missing).sort((a, b) => b.addedAt - a.addedAt))).catch(() => setList([]));
  }, [open]);
  const shown = (list ?? []).filter(f => !q || f.name.toLowerCase().includes(q.toLowerCase()));
  return <Sheet open={open} onClose={onClose} title="Choisir une image du vault" width={760}>
    <input className="input" placeholder="Filtrer par nom…" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 10 }} />
    {!list ? <div className="th-row"><Spinner /> Chargement du vault…</div>
      : !shown.length ? <Empty icon="🗂️" title="Aucune image">Importe des images dans Prisme (glisser-déposer dans une page ou onglet Fichiers).</Empty>
        : <div className="th-vault-grid">{shown.map(f => <button key={f.hash} type="button" className="th-press" onClick={() => { onPick(f); onClose(); }}>
          <div className="th-thumb"><img src={files.url(f)} alt="" loading="lazy" /></div>
          <div className="th-small" style={{ marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
        </button>)}</div>}
    <div className="th-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><Button variant="ghost" onClick={onClose}>Fermer</Button></div>
  </Sheet>;
}
export const Citations = ({ list }: { list: string[] }) => list.length ? <div className="th-col" style={{ gap: 2 }}>{list.map(c => <SourceCite key={c} text={c} />)}</div> : null;
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
