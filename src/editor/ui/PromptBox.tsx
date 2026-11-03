import { useMemo, useState } from 'react';
import katex from 'katex';

export function PromptBox({ title, placeholder, value, multiline, preview, confirmLabel = 'Valider', validate, onDone, onCancel }: {
  title: string; placeholder?: string; value?: string; multiline?: boolean; preview?: 'math-inline' | 'math-block';
  confirmLabel?: string; validate?: (v: string) => string | null; onDone: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(value ?? '');
  const [err, setErr] = useState<string | null>(null);
  const html = useMemo(() => {
    if (!preview || !v.trim()) return '';
    try { return katex.renderToString(v, { throwOnError: true, displayMode: preview === 'math-block' }); }
    catch (e) { return `<span class="katex-error">${String((e as Error).message).replace(/</g, '&lt;')}</span>`; }
  }, [v, preview]);
  const submit = () => {
    const msg = validate?.(v) ?? null;
    if (msg) { setErr(msg); return; }
    onDone(v);
  };
  const common = {
    autoFocus: true, className: 'input', placeholder, value: v,
    onChange: (e: { target: { value: string } }) => { setV(e.target.value); setErr(null); },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    },
  };
  return (
    <div className="prompt-box">
      <div className="prompt-title">{title}</div>
      {multiline ? <textarea {...common} rows={3} spellCheck={false} /> : <input {...common} />}
      {preview && <div className="prompt-preview" dangerouslySetInnerHTML={{ __html: html || '<span class="muted">Aperçu</span>' }} />}
      {err && <div className="prompt-err">{err}</div>}
      <div className="prompt-actions">
        {multiline && <span className="muted prompt-hint">Ctrl+Entrée pour valider</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Annuler</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={submit}>{confirmLabel}</button>
      </div>
    </div>
  );
}
