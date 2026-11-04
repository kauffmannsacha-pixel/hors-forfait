// Aperçus de fichiers : image, vidéo (1re image), audio, PDF (1re page), code (extrait coloré), Photoshop.
// Partagés par le popover de survol (size="sm"), le panneau latéral (size="lg") et la vue Fichiers (Thumb).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Spinner } from '../ui/kit';
import { backend } from './backend';
import type { VaultEntry } from './indexLogic';
import { extOf, fileKind, formatDuration, iconSvg, isTextual, KIND_META, languageOf, type FileKind } from './kinds';
import { firstLines, psdThumb, textExcerpt, videoThumb, type VideoThumb } from './media';
import { attempt, relocate } from './service';
import './files.css';

export function FileIcon({ kind, size = 18, tile = false }: { kind: FileKind; size?: number; tile?: boolean }) {
  return <span className={tile ? 'fx-icon-tile' : 'fx-icon'} style={{ color: KIND_META[kind].color, ['--kind' as string]: KIND_META[kind].color }} dangerouslySetInnerHTML={{ __html: iconSvg(kind, size) }} />;
}

/** Charge une valeur asynchrone liée à une clé (annule les résultats périmés). */
function useAsync<T>(key: string, fn: () => Promise<T>): { value: T | undefined; error: string | null; loading: boolean } {
  const [st, setSt] = useState<{ key: string; value?: T; error: string | null }>({ key: '', error: null });
  useEffect(() => {
    let alive = true;
    fn().then(value => alive && setSt({ key, value, error: null }), e => alive && setSt({ key, error: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = st.key === key;
  return { value: fresh ? st.value : undefined, error: fresh ? st.error : null, loading: !fresh };
}

// ───────────── Coloration syntaxique (lowlight, chargé à la demande) ─────────────
type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: string[] | string }; children?: HastNode[] };
type Low = { highlight: (lang: string, value: string) => { children: HastNode[] }; registered: (lang: string) => boolean };
let lowP: Promise<Low> | null = null;
const getLowlight = () => (lowP ??= import('lowlight').then(m => m.createLowlight(m.common) as unknown as Low));

function renderHast(nodes: HastNode[] | undefined, prefix = ''): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    if (n.type === 'text') return n.value ?? '';
    const cls = n.properties?.className;
    return <span key={prefix + i} className={Array.isArray(cls) ? cls.join(' ') : cls}>{renderHast(n.children, `${prefix}${i}.`)}</span>;
  });
}

function Highlighted({ code, lang }: { code: string; lang: string }) {
  const { value } = useAsync(`${lang}:${code.length}:${code.slice(0, 64)}`, async () => {
    const low = await getLowlight();
    if (lang === 'plaintext' || !low.registered(lang) || code.length > 300_000) return null;
    return renderHast(low.highlight(lang, code).children);
  });
  return <code className="hljs">{value ?? code}</code>;
}

export function CodeView({ file, size }: { file: VaultEntry; size: 'sm' | 'lg' }) {
  const maxBytes = size === 'sm' ? 8 * 1024 : 256 * 1024;
  const { value, error, loading } = useAsync(`${file.hash}:${file.path}:${file.modifiedAt ?? ''}:${maxBytes}`, () => textExcerpt(file, maxBytes));
  const lang = languageOf(file.name);
  const truncated = file.size > maxBytes;
  const view = useMemo(() => (value == null ? null : firstLines(value, size === 'sm' ? 30 : 100_000, truncated)), [value, size, truncated]);
  if (loading) return <div className="fx-code fx-center"><Spinner /></div>;
  if (error || !view) return <NoPreview kind={fileKind(file.name, file.mime)} text={error ?? 'Aperçu indisponible.'} />;
  const code = view.lines.join('\n');
  return (
    <div className={`fx-code fx-code-${size}`}>
      {lang.label && <span className="fx-lang">{lang.label}</span>}
      <pre className="fx-gutter" aria-hidden="true">{view.lines.map((_, i) => i + 1).join('\n')}</pre>
      <pre className="fx-src"><Highlighted code={code} lang={lang.id} /></pre>
      {view.more && <div className="fx-more">{size === 'sm' ? `Extrait — ${view.lines.length} premières lignes` : `Aperçu limité aux ${Math.round(maxBytes / 1024)} premiers Ko`}</div>}
    </div>
  );
}

export function NoPreview({ kind, text }: { kind: FileKind; text: string }) {
  return <div className="fx-nopreview"><FileIcon kind={kind} size={40} /><span className="muted">{text}</span></div>;
}

function VideoPoster({ file, size }: { file: VaultEntry; size: 'sm' | 'lg' }) {
  const { value, loading } = useAsync<VideoThumb | null>(`${file.hash}:${file.path}`, () => videoThumb(file));
  const url = backend.url(file);
  if (loading) return <div className="fx-media fx-center"><Spinner /></div>;
  return (
    <div className="fx-media fx-video-poster">
      {value?.dataUrl ? <img src={value.dataUrl} alt="" draggable={false} />
        : url ? <video src={`${url}#t=0.1`} muted preload="metadata" playsInline /> : null}
      <span className="fx-play" dangerouslySetInnerHTML={{ __html: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>' }} />
      {value && Number.isFinite(value.duration) && value.duration > 0 && <span className="fx-duration">{formatDuration(value.duration)}</span>}
      {size === 'sm' && value && value.width > 0 && <span className="fx-dims">{value.width}×{value.height}</span>}
    </div>
  );
}

function ImagePreview({ file, size }: { file: VaultEntry; size: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const url = backend.url(file);
  if (failed || !url) return <NoPreview kind="image" text="Format d'image non affichable ici." />;
  return (
    <div className={`fx-media fx-checker ${size === 'lg' ? 'fx-image-lg' : ''} ${zoom ? 'is-zoomed' : ''}`} onClick={size === 'lg' ? () => setZoom(z => !z) : undefined} title={size === 'lg' ? (zoom ? 'Ajuster' : 'Taille réelle') : undefined}>
      <img src={url} alt={file.name} draggable={false} decoding="async" onError={() => setFailed(true)} onLoad={e => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {dims && <span className="fx-dims">{dims.w}×{dims.h}</span>}
    </div>
  );
}

function PsdPreview({ file, size }: { file: VaultEntry; size: 'sm' | 'lg' }) {
  const { value, loading } = useAsync(`${file.hash}:${file.path}`, () => psdThumb(file));
  if (loading) return <div className="fx-media fx-center"><Spinner /></div>;
  if (!value?.url) return <NoPreview kind="design" text={value ? `Document Photoshop ${value.width}×${value.height} — pas de miniature intégrée.` : 'Aperçu Photoshop indisponible.'} />;
  return (
    <div className={`fx-media fx-checker ${size === 'lg' ? 'fx-image-lg' : ''}`}>
      <img src={value.url} alt={file.name} draggable={false} />
      <span className="fx-dims">{value.width}×{value.height} · miniature intégrée</span>
    </div>
  );
}

function AudioPreview({ file, size }: { file: VaultEntry; size: 'sm' | 'lg' }) {
  const url = backend.url(file);
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <div className={`fx-audio fx-audio-${size}`}>
      <div className="fx-audio-art"><FileIcon kind="audio" size={size === 'lg' ? 44 : 30} /></div>
      {duration != null && size === 'sm' && <span className="fx-duration fx-duration-static">{formatDuration(duration)}</span>}
      {url && <audio src={url} controls preload="metadata" onLoadedMetadata={e => setDuration(e.currentTarget.duration)} />}
    </div>
  );
}

function PdfPreview({ file, size }: { file: VaultEntry; size: 'sm' | 'lg' }) {
  const url = backend.url(file);
  if (!url) return <NoPreview kind="pdf" text="PDF introuvable." />;
  // Visionneuse PDF intégrée de WebView2 : 1re page, sans barre d'outils dans le popover.
  const hash = size === 'sm' ? '#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH' : '#view=FitH';
  return <div className={`fx-pdf fx-pdf-${size}`}><iframe src={url + hash} title={file.name} tabIndex={size === 'sm' ? -1 : 0} /></div>;
}

export function MissingNotice({ file }: { file: VaultEntry }) {
  return (
    <div className="fx-missing">
      <FileIcon kind={fileKind(file.name, file.mime)} size={34} />
      <b>Fichier introuvable</b>
      <span className="muted">{file.linked ? 'Le fichier lié a été déplacé, renommé ou supprimé.' : 'La copie du vault a disparu du disque.'}</span>
      <code className="fx-path">{file.path}</code>
      {backend.mode === 'tauri' && <Button size="sm" variant="primary" onClick={() => attempt(() => relocate(file.hash))}>Relocaliser…</Button>}
    </div>
  );
}

/** Aperçu adapté au type de fichier. */
export function FilePreview({ file, size }: { file: VaultEntry; size: 'sm' | 'lg' }) {
  if (file.missing) return <MissingNotice file={file} />;
  const kind = fileKind(file.name, file.mime);
  switch (kind) {
    case 'image': return <ImagePreview file={file} size={size} />;
    case 'video': return size === 'lg' ? <VideoPlayer file={file} /> : <VideoPoster file={file} size={size} />;
    case 'audio': return <AudioPreview file={file} size={size} />;
    case 'pdf': return <PdfPreview file={file} size={size} />;
    case 'design': return ['psd', 'psb'].includes(extOf(file.name)) ? <PsdPreview file={file} size={size} /> : <NoPreview kind={kind} text="Pas d'aperçu intégré pour ce format." />;
    default:
      if (isTextual(kind)) return <CodeView file={file} size={size} />;
      return <NoPreview kind={kind} text="Pas d'aperçu pour ce type de fichier." />;
  }
}

function VideoPlayer({ file }: { file: VaultEntry }) {
  const { value } = useAsync<VideoThumb | null>(`${file.hash}:${file.path}`, () => videoThumb(file));
  const [failed, setFailed] = useState(false);
  const url = backend.url(file);
  if (failed || !url) return <NoPreview kind="video" text="Ce format vidéo ne peut pas être lu ici — ouvre-le avec l'application Windows." />;
  return <div className="fx-media fx-video-lg"><video src={url} controls preload="metadata" poster={value?.dataUrl ?? undefined} onError={() => setFailed(true)} /></div>;
}

/** Vignette compacte pour la grille de la vue Fichiers (chargée seulement quand elle devient visible). */
export function Thumb({ file }: { file: VaultEntry }) {
  const kind = fileKind(file.name, file.mime);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!el || visible) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [el, visible]);
  let body: ReactNode = <FileIcon kind={kind} size={34} />;
  if (visible && !file.missing) {
    if (kind === 'image') body = <ThumbImage file={file} />;
    else if (kind === 'video') body = <VideoPoster file={file} size="sm" />;
    else if (kind === 'design' && ['psd', 'psb'].includes(extOf(file.name))) body = <ThumbPsd file={file} />;
    else if (isTextual(kind)) body = <ThumbCode file={file} />;
  }
  return <div ref={setEl} className={`fx-thumb fx-thumb-${kind}`} style={{ ['--kind' as string]: KIND_META[kind].color }}>{body}</div>;
}
function ThumbImage({ file }: { file: VaultEntry }) {
  const [failed, setFailed] = useState(false);
  const url = backend.url(file);
  return failed || !url ? <FileIcon kind="image" size={34} /> : <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}
function ThumbPsd({ file }: { file: VaultEntry }) {
  const { value } = useAsync(`${file.hash}:${file.path}`, () => psdThumb(file));
  return value?.url ? <img src={value.url} alt="" draggable={false} /> : <FileIcon kind="design" size={34} />;
}
function ThumbCode({ file }: { file: VaultEntry }) {
  const { value } = useAsync(`${file.hash}:${file.path}:${file.modifiedAt ?? ''}:2048`, () => textExcerpt(file, 2048));
  if (value == null) return <FileIcon kind={fileKind(file.name, file.mime)} size={34} />;
  return <pre className="fx-thumb-code">{firstLines(value, 9, file.size > 2048).lines.join('\n')}</pre>;
}
