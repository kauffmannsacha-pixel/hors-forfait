// Kit UI Liquid Glass partagé. Le module UI peut le restyler, mais garde ces exports et props.
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; icon?: ReactNode; loading?: boolean };
export function Button({ variant = 'secondary', size = 'md', icon, loading, children, className = '', disabled, ...rest }: BtnProps) {
  return <button className={`btn btn-${variant} btn-${size} ${className}`} disabled={disabled || loading} {...rest}>{loading ? <Spinner /> : icon}{children}</button>;
}
export function Card({ children, className = '', title, actions, ...rest }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`glass card ${className}`} {...rest}>{(title || actions) && <div className="card-head"><div className="card-title">{title}</div><div>{actions}</div></div>}{children}</div>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ''}`} />;
export const TextArea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`input ${p.className ?? ''}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`input ${p.className ?? ''}`} />;
export const Spinner = () => <span className="spinner" aria-label="Chargement" />;
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string }[] }) {
  return <div className="tabs" role="tablist">{tabs.map(t => <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
export function Sheet({ open, onClose, title, children, width = 560 }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [open, onClose]);
  if (!open) return null;
  return <div className="scrim" onPointerDown={e => e.target === e.currentTarget && onClose()}><div className="glass sheet" style={{ width }} role="dialog">{title && <div className="sheet-title">{title}</div>}{children}</div></div>;
}
export const Empty = ({ icon = '✨', title, children }: { icon?: string; title: string; children?: ReactNode }) =>
  <div className="empty"><div className="empty-icon">{icon}</div><div className="empty-title">{title}</div>{children && <div className="muted">{children}</div>}</div>;
/** Note /10 colorée. */
export function Score({ value, max = 10, label }: { value: number; max?: number; label?: string }) {
  const r = value / max; const c = r >= 0.75 ? 'var(--good)' : r >= 0.5 ? 'var(--warn)' : 'var(--bad)';
  return <span className="score" style={{ color: c, borderColor: c }}>{label && <span className="muted">{label} </span>}<b>{Number.isInteger(value) ? value : value.toFixed(1)}</b>/{max}</span>;
}
export const Chip = ({ children, color, onClick }: { children: ReactNode; color?: string; onClick?: () => void }) =>
  <span className="chip" style={color ? { background: color } : undefined} onClick={onClick}>{children}</span>;
/** Citation d'une source de la base de connaissances. */
export const SourceCite = ({ text }: { text: string }) => <span className="cite">📚 {text}</span>;
