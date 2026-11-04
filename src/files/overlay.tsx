// Calque flottant global du module (racine React dédiée) : popover d'aperçu des puces,
// indicateur de dépôt (point d'insertion + badge), HUD de progression des imports.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { openSidePanel } from '../ui/appState';
import { Button } from '../ui/kit';
import { dropLabel, useDropUi } from './dragDrop';
import { fileKind, formatDate, formatSize, iconSvg, KIND_META, kindLabel, truncateMiddle } from './kinds';
import { useImportJobs } from './jobs';
import { FileIcon, FilePreview } from './Preview';
import { hidePinPopover, hidePinPopoverSoon, keepPinPopover, usePinPopover } from './popover';
import { attempt, open } from './service';
import { useVault } from './store';
import './files.css';

const spring = { type: 'spring' as const, bounce: 0, duration: 0.3 };

function PinPopover() {
  const { attrs, anchor, quickLook } = usePinPopover();
  const entry = useVault(s => (attrs ? s.files[attrs.hash] : undefined));
  const loaded = useVault(s => s.loaded);
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean; originX: number } | null>(null);

  useLayoutEffect(() => {
    if (!attrs || !anchor) { setPos(null); return; }
    const place = () => {
      const el = ref.current; if (!el || !anchor.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const w = el.offsetWidth; const h = el.offsetHeight; const m = 10;
      const below = r.bottom + m + h <= window.innerHeight - 8 || r.top - m - h < 8;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      setPos({ left, top: below ? r.bottom + m : r.top - m - h, below, originX: r.left + r.width / 2 - left });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [attrs, anchor]);

  useEffect(() => {
    if (!attrs) return;
    const close = () => hidePinPopover();
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', close); window.removeEventListener('blur', close); };
  }, [attrs]);

  const kind = attrs ? fileKind(attrs.name, attrs.mime) : 'other';
  return (
    <AnimatePresence>
      {attrs && (
        <motion.div
          key={attrs.hash}
          ref={ref}
          className="fx-pop glass"
          role="dialog"
          aria-label={`Aperçu de ${attrs.name}`}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, transformOrigin: `${pos?.originX ?? 0}px ${pos?.below ? 0 : '100%'}` }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, filter: 'blur(4px)', transition: { duration: 0.14 } }}
          transition={spring}
          onPointerEnter={keepPinPopover}
          onPointerLeave={() => hidePinPopoverSoon()}
        >
          {entry ? (
            <>
              <div className="fx-pop-preview"><FilePreview file={entry} size="sm" /></div>
              <div className="fx-pop-info">
                <FileIcon kind={kind} size={18} />
                <div className="fx-pop-text">
                  <div className="fx-pop-name" title={entry.name}>{truncateMiddle(entry.name, 44)}</div>
                  <div className="fx-pop-meta">
                    {kindLabel(entry.name, entry.mime)} · {formatSize(entry.size)} · {entry.missing ? <span className="fx-bad">introuvable</span> : entry.linked ? 'lié' : 'copié'}
                    <br />Ajouté le {formatDate(entry.addedAt)}
                  </div>
                </div>
              </div>
              <div className="fx-pop-actions">
                <Button size="sm" variant="ghost" onClick={() => { hidePinPopover(); openSidePanel('file', { hash: entry.hash }); }}>Aperçu</Button>
                {!entry.missing && <Button size="sm" variant="ghost" onClick={() => { hidePinPopover(); attempt(() => open(entry.hash, 'system')); }}>Ouvrir</Button>}
                <span className="fx-pop-hint">{quickLook ? 'Échap pour fermer' : 'Ctrl+clic : ouvrir'}</span>
              </div>
            </>
          ) : (
            <div className="fx-pop-unknown">
              <FileIcon kind={kind} size={28} />
              <div><b>{attrs.name}</b><div className="muted">{loaded ? "Ce fichier n'est pas dans le vault de cet ordinateur (introuvable)." : 'Chargement…'}</div></div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DropIndicator() {
  const ui = useDropUi();
  const reduce = useReducedMotion();
  const { title, sub } = dropLabel(ui);
  const follow = reduce ? { duration: 0 } : { type: 'spring' as const, bounce: 0, duration: 0.2 };
  return (
    <AnimatePresence>
      {ui.active && ui.caret && (
        <motion.div
          key="caret"
          className={`fx-drop-caret${ui.caret.horizontal ? ' is-h' : ''}`}
          initial={{ opacity: 0, x: ui.caret.left, y: ui.caret.top }}
          animate={{ opacity: 1, x: ui.caret.left, y: ui.caret.top, height: ui.caret.horizontal ? 3 : ui.caret.height, width: ui.caret.horizontal ? ui.caret.width : 3 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          transition={follow}
        />
      )}
      {ui.active && (
        <motion.div
          key="badge"
          className={`fx-drop-badge glass${ui.target === 'ignore' ? ' is-muted' : ''}`}
          initial={{ opacity: 0, scale: 0.9, x: ui.x + 18, y: ui.y + 20 }}
          animate={{ opacity: 1, scale: 1, x: ui.x + 18, y: ui.y + 20 }}
          exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.12 } }}
          transition={follow}
        >
          <span className="fx-drop-icons">
            {(ui.kinds.length ? ui.kinds : (['other'] as const)).map((k, i) => (
              <span key={i} className="fx-drop-icon" style={{ color: KIND_META[k].color, zIndex: 3 - i }} dangerouslySetInnerHTML={{ __html: iconSvg(k, 16) }} />
            ))}
          </span>
          <span className="fx-drop-text">
            <b>{title}</b>
            <span className={ui.link ? 'fx-drop-sub is-link' : 'fx-drop-sub'}>{sub}</span>
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ImportHud() {
  const jobs = useImportJobs(s => s.jobs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!jobs.length) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [jobs.length]);
  // Seuls les imports qui durent (> 0,5 s) apparaissent : pas de clignotement pour les petits fichiers.
  const shown = jobs.filter(j => (j.endedAt ?? now) - j.startedAt > 500);
  return (
    <div className="fx-hud" aria-live="polite">
      <AnimatePresence initial={false}>
        {shown.map(j => {
          const p = j.total > 0 ? Math.min(1, j.done / j.total) : 0;
          const kind = fileKind(j.name);
          return (
            <motion.div key={j.id} layout className={`fx-hud-item glass is-${j.status}`}
              initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }} transition={spring}>
              <FileIcon kind={kind} size={18} />
              <div className="fx-hud-body">
                <div className="fx-hud-name">{truncateMiddle(j.name, 34)}</div>
                <div className="fx-hud-bar"><span style={{ transform: `scaleX(${j.status === 'running' ? p : 1})` }} /></div>
                <div className="fx-hud-meta">
                  {j.status === 'error' ? 'Échec' : j.status === 'done' ? 'Ajouté au vault' : j.total ? `${formatSize(j.done)} sur ${formatSize(j.total)}` : 'Préparation…'}
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function Overlay() {
  return <><PinPopover /><DropIndicator /><ImportHud /></>;
}

let mounted = false;
/** Monte le calque une seule fois (racine React indépendante, au-dessus de l'app). */
export function mountOverlay() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const start = () => {
    const host = document.createElement('div');
    host.className = 'fx-overlay-root';
    document.body.appendChild(host);
    createRoot(host).render(<Overlay />);
  };
  if (document.body) start(); else window.addEventListener('DOMContentLoaded', start, { once: true });
}
