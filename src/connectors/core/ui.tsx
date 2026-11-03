// Composants UI partagés du module connecteurs (Liquid Glass, ressorts interruptibles, reduced-motion respecté).
import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { isTauri } from '../../db/store';
import { toast } from '../../ui/appState';
import '../connectors.css';

export const SPRING = { type: 'spring' as const, bounce: 0, duration: 0.42 };
export const useSpring = () => (useReducedMotion() ? { duration: 0 } : SPRING);

/** Ouvre un lien dans le navigateur système (plugin opener dans l'app). */
export async function openExternal(url: string) {
  try {
    if (isTauri) { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); }
    else window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) { toast(`Impossible d’ouvrir le lien : ${e instanceof Error ? e.message : String(e)}`, 'error'); }
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} className="cx-link" onClick={e => { e.preventDefault(); void openExternal(href); }}>{children}</a>;
}

export type Tone = 'ok' | 'warn' | 'error' | 'idle' | 'busy';
export const StatusPill = ({ tone, children }: { tone: Tone; children: ReactNode }) =>
  <span className={`cx-pill cx-pill-${tone}`}>{children}</span>;

export function Avatar({ src, label, size = 32, round = true }: { src?: string; label: string; size?: number; round?: boolean }) {
  const [broken, setBroken] = useState(false);
  const initials = label.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || '•';
  const style = { width: size, height: size, borderRadius: round ? '50%' : 8, fontSize: Math.round(size * 0.4) };
  return src && !broken
    ? <img className="cx-avatar" src={src} alt="" style={style} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <span className="cx-avatar cx-avatar-fallback" style={style} aria-hidden>{initials}</span>;
}

/** Section repliable (hauteur animée par ressort, sans rebond). */
export function Disclosure({ title, children, defaultOpen = false, right }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const spring = useSpring();
  const id = useId();
  return (
    <div className={`cx-disclosure${open ? ' open' : ''}`}>
      <div className="cx-disclosure-head">
        <button type="button" className="cx-disclosure-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
          <motion.span className="cx-chevron" animate={{ rotate: open ? 90 : 0 }} transition={spring} aria-hidden>›</motion.span>
          {title}
        </button>
        {right}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={id} key="body" className="cx-disclosure-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring}>
            <div className="cx-disclosure-inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Mini-guide pas à pas. */
export function Guide({ title = 'Mini-guide', steps, defaultOpen = false }: { title?: string; steps: ReactNode[]; defaultOpen?: boolean }) {
  return (
    <Disclosure title={<span>📘 {title}</span>} defaultOpen={defaultOpen}>
      <ol className="cx-guide">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
    </Disclosure>
  );
}

/** Interrupteur façon iOS. */
export function Toggle({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={`cx-toggle${disabled ? ' disabled' : ''}`}>
      <span className="cx-toggle-text"><span>{label}</span>{hint && <span className="cx-hint">{hint}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="cx-switch" aria-hidden><span className="cx-knob" /></span>
    </label>
  );
}

/** Jauge (quota…) : la couleur porte la sévérité, la piste reste de la même famille. */
export function Meter({ value, max, label, detail }: { value: number; max: number; label: ReactNode; detail?: ReactNode }) {
  const r = max > 0 ? Math.min(1, value / max) : 0;
  const tone = r >= 0.9 ? 'bad' : r >= 0.7 ? 'warn' : 'ok';
  return (
    <div className="cx-meter">
      <div className="cx-meter-top"><span>{label}</span><span className="cx-meter-val">{detail}</span></div>
      <div className={`cx-meter-track cx-meter-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className="cx-meter-fill" style={{ transform: `scaleX(${r})` }} />
      </div>
    </div>
  );
}

/** Champ secret masqué avec bouton « Afficher ». */
export function SecretInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="cx-secret">
      <input className="input" type={show ? 'text' : 'password'} value={value} placeholder={placeholder} autoFocus={autoFocus}
        autoComplete="off" spellCheck={false} onChange={e => onChange(e.target.value)} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow(s => !s)}>{show ? 'Masquer' : 'Afficher'}</button>
    </div>
  );
}

/** Valeur copiable (jeton…), masquée par défaut. */
export function CopyField({ value, secret = true }: { value: string; secret?: boolean }) {
  const [show, setShow] = useState(!secret);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast('Copié dans le presse-papiers.', 'success'); }
    catch { toast('Copie impossible — sélectionne le texte manuellement.', 'warning'); }
  };
  return (
    <div className="cx-secret">
      <input className="input cx-mono" readOnly value={show ? value : '•'.repeat(Math.min(32, value.length))} onFocus={e => show && e.target.select()} />
      {secret && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow(s => !s)}>{show ? 'Masquer' : 'Afficher'}</button>}
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>Copier</button>
    </div>
  );
}

/** Message d'erreur en ligne. */
export const InlineError = ({ children }: { children: ReactNode }) => children ? <div className="cx-inline-error" role="alert">{children}</div> : null;
