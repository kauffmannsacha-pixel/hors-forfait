// Réglages Google : identifiants OAuth (Client ID / secret) + mini-guide + services par compte.
import { useEffect, useState } from 'react';
import { Button, Field, Input } from '../../ui/kit';
import { toast } from '../../ui/appState';
import { GOOGLE_SCOPES } from '../api';
import { ExternalLink, Guide, InlineError, SecretInput, Toggle } from '../core/ui';
import { errorMessage, isCancelled } from '../core/errors';
import { useConnectorsVersion } from '../core/events';
import { openSheet } from '../core/overlay';
import { clientConfigStatus, setClientConfig } from './oauth';
import { connectGoogle, ensureGoogleScopes, hasScopes, listGoogleAccounts, type GoogleAccountMeta } from './accounts';

export const GOOGLE_SERVICES: { id: 'calendar' | 'drive' | 'gmail'; label: string; hint: string; scopes: string[] }[] = [
  { id: 'calendar', label: 'Agenda', hint: 'Vue Calendrier unifiée, création d’événements', scopes: GOOGLE_SCOPES.calendar },
  { id: 'drive', label: 'Drive', hint: 'Recherche et épinglage de fichiers dans les pages', scopes: GOOGLE_SCOPES.drive },
  { id: 'gmail', label: 'Gmail', hint: 'Boîte mail intégrée (lecture, brouillons — jamais d’envoi automatique)', scopes: GOOGLE_SCOPES.gmail },
];

export function GoogleGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Guide title="Créer ses identifiants Google (5 min)" defaultOpen={defaultOpen} steps={[
      <>Ouvre la <ExternalLink href="https://console.cloud.google.com/projectcreate">console Google Cloud</ExternalLink> et crée un projet (ex. « Prisme »).</>,
      <>Dans <ExternalLink href="https://console.cloud.google.com/apis/library">API et services → Bibliothèque</ExternalLink>, active : <b>YouTube Data API v3</b>, <b>YouTube Analytics API</b>, <b>Google Calendar API</b>, <b>Google Drive API</b> et <b>Gmail API</b>.</>,
      <>Dans <ExternalLink href="https://console.cloud.google.com/auth/overview">Google Auth Platform</ExternalLink> : audience <b>Externe</b>, ajoute ton adresse comme utilisateur test, puis <b>Publier l’application</b> (sinon Google expire les jetons au bout de 7 jours). L’écran « Application non validée » apparaîtra : <i>Paramètres avancés → Accéder à Prisme</i>.</>,
      <>Dans <ExternalLink href="https://console.cloud.google.com/auth/clients">Clients</ExternalLink> → <b>Créer un client</b> → type <b>Application de bureau</b>. Copie l’<b>ID client</b> et le <b>code secret</b> ci-dessous.</>,
      <>Pour les données publiques YouTube, crée aussi une <ExternalLink href="https://console.cloud.google.com/apis/credentials">clé API</ExternalLink> (restreinte à « YouTube Data API v3 ») et colle-la dans la carte YouTube.</>,
    ]} />
  );
}

/** Formulaire Client ID / secret (réutilisé par la feuille de connexion). */
export function ClientConfigForm({ onSaved }: { onSaved?: () => void }) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { void clientConfigStatus().then(s => { setClientId(s.clientId); setHasSecret(s.hasSecret); }); }, []);
  const save = async () => {
    setBusy(true); setErr('');
    try { await setClientConfig(clientId, secret || undefined); setSecret(''); setHasSecret(h => h || !!secret); toast('Identifiants Google enregistrés.', 'success'); onSaved?.(); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <form className="cx-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <Field label="ID client OAuth" hint="Type « Application de bureau » — se termine par .apps.googleusercontent.com">
        <Input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="123456789-abc.apps.googleusercontent.com" spellCheck={false} />
      </Field>
      <Field label="Code secret du client" hint={hasSecret ? 'Un secret est enregistré dans le coffre — laisse vide pour le conserver.' : 'Stocké dans le coffre Windows, jamais en clair.'}>
        <SecretInput value={secret} onChange={setSecret} placeholder={hasSecret ? '•••••••• (enregistré)' : 'GOCSPX-…'} />
      </Field>
      <InlineError>{err}</InlineError>
      <div className="cx-actions"><Button type="submit" variant="primary" size="sm" loading={busy} disabled={!clientId.trim()}>Enregistrer</Button></div>
    </form>
  );
}

function ConnectChooser({ done }: { done: (a?: GoogleAccountMeta) => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [pick, setPick] = useState<Record<string, boolean>>({ calendar: true, drive: true, gmail: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const check = () => clientConfigStatus().then(s => setReady(!!s.clientId));
  useEffect(() => { void check(); }, []);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const scopes = GOOGLE_SERVICES.filter(s => pick[s.id]).flatMap(s => s.scopes);
      done(await connectGoogle(scopes));
    } catch (e) { if (!isCancelled(e)) setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  if (ready === null) return null;
  if (!ready) return (
    <div className="cx-stack">
      <p className="muted">Pour te connecter, Prisme a besoin de ton propre identifiant OAuth Google (gratuit) : tes données restent entre toi et Google.</p>
      <GoogleGuide defaultOpen />
      <ClientConfigForm onSaved={() => void check()} />
    </div>
  );
  return (
    <div className="cx-stack">
      <p className="muted">Choisis les services à autoriser. Tu pourras en ajouter plus tard : Prisme les redemandera au moment voulu.</p>
      <div className="cx-toggles">
        {GOOGLE_SERVICES.map(s => <Toggle key={s.id} label={s.label} hint={s.hint} checked={!!pick[s.id]} onChange={v => setPick(p => ({ ...p, [s.id]: v }))} />)}
      </div>
      <InlineError>{err}</InlineError>
      {busy && <p className="cx-hint">Termine la connexion dans ton navigateur… (la fenêtre se ferme toute seule côté Prisme)</p>}
      <div className="cx-actions">
        <Button variant="ghost" onClick={() => done()}>Annuler</Button>
        <Button variant="primary" loading={busy} onClick={() => void go()}>Continuer dans le navigateur</Button>
      </div>
    </div>
  );
}

export const openGoogleConnect = () => openSheet<GoogleAccountMeta>('Connecter un compte Google', close => <ConnectChooser done={close} />, 560);

export function GoogleSettings() {
  const v = useConnectorsVersion(s => s.v);
  const [accounts, setAccounts] = useState<GoogleAccountMeta[]>([]);
  const [busy, setBusy] = useState('');
  useEffect(() => { void listGoogleAccounts().then(setAccounts); }, [v]);
  const add = async (a: GoogleAccountMeta, scopes: string[], key: string) => {
    setBusy(key);
    try { await ensureGoogleScopes(a.id, scopes); toast('Autorisation ajoutée.', 'success'); }
    catch (e) { if (!isCancelled(e)) toast(errorMessage(e), 'error'); } finally { setBusy(''); }
  };
  return (
    <div className="cx-stack">
      <GoogleGuide />
      <div className="cx-subtitle">Identifiants OAuth</div>
      <ClientConfigForm />
      {accounts.length > 0 && <div className="cx-subtitle">Services autorisés</div>}
      {accounts.map(a => (
        <div key={a.id} className="cx-service-row">
          <span className="cx-service-email">{a.email}</span>
          <div className="cx-chips">
            {GOOGLE_SERVICES.map(s => hasScopes(a.scopes, s.scopes)
              ? <span key={s.id} className="cx-chip on">✓ {s.label}</span>
              : <button key={s.id} type="button" className="cx-chip add" disabled={!!busy} onClick={() => void add(a, s.scopes, a.id + s.id)}>{busy === a.id + s.id ? '…' : '+'} {s.label}</button>)}
            {a.needsReauth && <button type="button" className="cx-chip warn" onClick={() => void add(a, [], a.id + 're')}>Reconnecter</button>}
          </div>
        </div>
      ))}
      <p className="cx-hint">Pour retirer complètement l’accès de Prisme à un compte : <ExternalLink href="https://myaccount.google.com/connections">myaccount.google.com → Applications tierces</ExternalLink>.</p>
    </div>
  );
}
