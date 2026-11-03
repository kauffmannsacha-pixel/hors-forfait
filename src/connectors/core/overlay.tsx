// Feuilles modales autonomes (montées dans leur propre racine React) : utilisables depuis une commande,
// un item « / » ou `connector.auth.connect()` sans dépendre de la coque.
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Field, Sheet } from '../../ui/kit';
import type { ConnectorAccount } from '../api';
import { ConnectorError, errorMessage } from './errors';
import { InlineError, SecretInput } from './ui';
import '../connectors.css';

export function openOverlay<T>(render: (close: (value?: T) => void) => ReactNode): Promise<T | undefined> {
  return new Promise(resolve => {
    const host = document.createElement('div');
    host.className = 'cx-overlay-host';
    document.body.appendChild(host);
    const root = createRoot(host);
    let done = false;
    const close = (value?: T) => {
      if (done) return;
      done = true;
      resolve(value);
      setTimeout(() => { root.unmount(); host.remove(); }, 0);
    };
    root.render(<>{render(close)}</>);
  });
}

/** Feuille Liquid Glass (Échap / clic hors feuille = fermer). */
export function openSheet<T>(title: ReactNode, body: (close: (value?: T) => void) => ReactNode, width = 560): Promise<T | undefined> {
  return openOverlay<T>(close => <Sheet open title={title} onClose={() => close()} width={width}>{body(close)}</Sheet>);
}

export interface KeyPromptOptions {
  title: string; label: string; placeholder?: string; hint?: string;
  guide?: ReactNode; submitLabel?: string;
  /** Valide la clé (appel API) et l'enregistre ; renvoie le compte connecté. */
  validate: (value: string) => Promise<ConnectorAccount>;
}

function KeyPrompt({ o, done }: { o: KeyPromptOptions; done: (a?: ConnectorAccount) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    const v = value.trim();
    if (!v) { setErr('Colle la clé avant de valider.'); return; }
    setBusy(true); setErr('');
    try { done(await o.validate(v)); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <form className="cx-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {o.guide}
      <Field label={o.label} hint={o.hint ?? 'Stockée dans le coffre Windows (Gestionnaire d’identification), jamais en clair.'}>
        <SecretInput value={value} onChange={setValue} placeholder={o.placeholder} autoFocus />
      </Field>
      <InlineError>{err}</InlineError>
      <div className="cx-actions">
        <Button type="button" variant="ghost" onClick={() => done()}>Annuler</Button>
        <Button type="submit" variant="primary" loading={busy}>{o.submitLabel ?? 'Vérifier et connecter'}</Button>
      </div>
    </form>
  );
}

/** Demande une clé API / un jeton, la valide, et renvoie le compte (rejette si annulé). */
export async function promptForKey(o: KeyPromptOptions): Promise<ConnectorAccount> {
  const acc = await openSheet<ConnectorAccount>(o.title, close => <KeyPrompt o={o} done={close} />, 600);
  if (!acc) throw new ConnectorError('Connexion annulée.', { cancelled: true });
  return acc;
}
