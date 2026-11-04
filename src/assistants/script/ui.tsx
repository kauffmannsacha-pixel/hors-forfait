// Petits composants partagés (Liquid Glass) de l'assistant script et du générateur de titres.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion, AnimatePresence } from 'motion/react';

export const SPRING = { type: 'spring', bounce: 0, duration: 0.4 } as const;
export const fmt1 = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','));

export function useLatest<T>(v: T) { const r = useRef(v); r.current = v; return r; }

/** Valeur locale + enregistrement différé (évite d'écrire en base à chaque frappe). */
export function useDraft<T>(value: T, commit: (v: T) => void, delay = 450): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  const pending = useRef<{ v: T } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const commitRef = useLatest(commit);
  useEffect(() => { if (value !== last.current && !pending.current) { last.current = value; setDraft(value); } }, [value]);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); if (pending.current) commitRef.current(pending.current.v); } }, [commitRef]);
  const set = (v: T) => {
    setDraft(v); last.current = v; pending.current = { v };
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = undefined; const p = pending.current; pending.current = null; if (p) commitRef.current(p.v); }, delay);
  };
  return [draft, set];
}

/** Anneau de score /10 animé par ressort (sans rebond). */
export function ScoreRing({ value, size = 78, label }: { value: number | null; size?: number; label?: string }) {
  const reduce = useReducedMotion();
  const r = (size - 8) / 2; const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(10, value));
  const color = v >= 7.5 ? 'var(--good)' : v >= 5 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div className="pr-ring" style={{ width: size, height: size }} role="img" aria-label={`${label ?? 'Score'} : ${value == null ? 'non calculé' : fmt1(v)} sur 10`}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="pr-ring-track" />
        <motion.circle cx={size / 2} cy={size / 2} r={r} className="pr-ring-val" stroke={color} strokeDasharray={c}
          initial={false} animate={{ strokeDashoffset: c * (1 - v / 10) }} transition={reduce ? { duration: 0 } : SPRING}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="pr-ring-num"><b>{value == null ? '–' : fmt1(Math.round(v * 10) / 10)}</b><span>/10</span></div>
    </div>
  );
}

/** Menu flottant ancré sur son déclencheur (se ferme au clic extérieur / Échap). */
export function PopMenu({ label, children, align = 'left', className = '', disabled }: { label: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', down); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className={`pr-pop ${className}`} ref={ref}>
      <button type="button" className="btn btn-secondary btn-md" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(o => !o)}>{label}</button>
      <AnimatePresence>
        {open && (
          <motion.div role="menu" className={`glass pr-pop-menu pr-pop-${align}`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4, filter: 'blur(4px)' }}
            transition={reduce ? { duration: 0.12 } : SPRING}>
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
export const MenuItem = ({ icon, title, desc, onClick, disabled }: { icon?: ReactNode; title: string; desc?: string; onClick: () => void; disabled?: boolean }) => (
  <button type="button" role="menuitem" className="pr-menu-item" onClick={onClick} disabled={disabled}>
    {icon != null && <span className="pr-menu-icon">{icon}</span>}
    <span><span className="pr-menu-title">{title}</span>{desc && <span className="pr-menu-desc">{desc}</span>}</span>
  </button>
);

/** Copie dans le presse-papiers (API web ; disponible dans le webview Tauri). */
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove();
    if (!ok) throw new Error('Impossible de copier dans le presse-papiers.');
  }
}
