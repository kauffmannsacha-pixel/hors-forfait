// Sélecteur Google Drive : recherche → téléchargement → import dans le vault → épinglage dans la page courante.
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Input, Select, Spinner, Tabs } from '../../ui/kit';
import { toast } from '../../ui/appState';
import { errorMessage, isCancelled } from '../core/errors';
import { formatBytes, timeAgo } from '../core/format';
import { InlineError } from '../core/ui';
import { openSheet } from '../core/overlay';
import { ensureGoogleScopes, hasScopes, listGoogleAccounts, type GoogleAccountMeta } from './accounts';
import { canPin, DRIVE_SCOPES, EXPORTS, pinDriveFile, searchDrive, type DriveFile } from './drive';
import { openGoogleConnect } from './GoogleSettings';

const mimeIcon = (m: string) =>
  m.startsWith('image/') ? '🖼️' : m.startsWith('video/') ? '🎬' : m.startsWith('audio/') ? '🎧' : m === 'application/pdf' ? '📕'
    : m.includes('spreadsheet') || m.includes('excel') ? '📊' : m.includes('presentation') ? '📽️' : m.includes('document') || m.startsWith('text/') ? '📄'
      : m.includes('zip') ? '🗜️' : '📎';

function DrivePicker({ close }: { close: () => void }) {
  const [accounts, setAccounts] = useState<GoogleAccountMeta[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'name' | 'fullText'>('name');
  const [items, setItems] = useState<DriveFile[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [pinning, setPinning] = useState('');
  const seq = useRef(0);

  const reloadAccounts = async () => {
    const list = await listGoogleAccounts();
    setAccounts(list);
    setAccountId(cur => (list.find(a => a.id === cur) ? cur : (list.find(a => hasScopes(a.scopes, DRIVE_SCOPES)) ?? list[0])?.id ?? ''));
  };
  useEffect(() => { void reloadAccounts(); }, []);

  const account = accounts?.find(a => a.id === accountId);
  const authorized = !!account && hasScopes(account.scopes, DRIVE_SCOPES) && !account.needsReauth;

  const run = async (append = false) => {
    if (!account || !authorized) return;
    const my = ++seq.current;
    setLoading(true); setErr('');
    try {
      const res = await searchDrive(account.id, q, { mode, pageToken: append ? next : undefined });
      if (my !== seq.current) return;
      setItems(cur => (append ? [...cur, ...res.files] : res.files));
      setNext(res.nextPageToken);
    } catch (e) { if (my === seq.current) setErr(errorMessage(e)); } finally { if (my === seq.current) setLoading(false); }
  };
  useEffect(() => {
    const t = setTimeout(() => void run(false), q ? 320 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, mode, accountId, authorized]);

  const authorize = async () => {
    if (!account) return;
    try { await ensureGoogleScopes(account.id, DRIVE_SCOPES); await reloadAccounts(); }
    catch (e) { if (!isCancelled(e)) setErr(errorMessage(e)); }
  };
  const pin = async (f: DriveFile) => {
    if (!account) return;
    setPinning(f.id); setErr('');
    try { const vf = await pinDriveFile(account.id, f); toast(`« ${vf.name} » épinglé dans la page.`, 'success'); close(); }
    catch (e) { setErr(errorMessage(e)); } finally { setPinning(''); }
  };

  if (accounts === null) return <div className="cx-center"><Spinner /></div>;
  if (!accounts.length) return (
    <Empty icon="🗂️" title="Aucun compte Google connecté">
      <div className="cx-actions cx-center"><Button variant="primary" onClick={() => void openGoogleConnect().then(() => reloadAccounts())}>Connecter Google</Button></div>
    </Empty>
  );
  return (
    <div className="cx-stack cx-drive">
      <div className="cx-row-wrap">
        {accounts.length > 1 && (
          <Select value={accountId} onChange={e => setAccountId(e.target.value)} style={{ maxWidth: 240 }}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
          </Select>
        )}
        <Input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={mode === 'name' ? 'Rechercher par nom…' : 'Rechercher dans le contenu…'} style={{ flex: 1, minWidth: 200 }} />
        <Tabs value={mode} onChange={setMode} tabs={[{ id: 'name', label: 'Nom' }, { id: 'fullText', label: 'Contenu' }]} />
      </div>
      {!authorized ? (
        <Empty icon="🔐" title="Autoriser Google Drive">
          <p>Prisme a besoin d’un accès en lecture à Drive pour {account?.email}.</p>
          <div className="cx-actions cx-center"><Button variant="primary" onClick={() => void authorize()}>Autoriser dans le navigateur</Button></div>
        </Empty>
      ) : (
        <div className="cx-drive-list" aria-busy={loading}>
          {items.map(f => (
            <div key={f.id} className={`cx-drive-item${canPin(f) ? '' : ' disabled'}`}>
              {f.thumbnailLink ? <img className="cx-drive-thumb" src={f.thumbnailLink} alt="" referrerPolicy="no-referrer" /> : <span className="cx-drive-thumb cx-drive-icon">{mimeIcon(f.mimeType)}</span>}
              <div className="cx-drive-meta">
                <div className="cx-drive-name" title={f.name}>{f.name}</div>
                <div className="cx-hint">{[EXPORTS[f.mimeType]?.label, f.size ? formatBytes(f.size) : '', f.modifiedTime ? `modifié ${timeAgo(Date.parse(f.modifiedTime))}` : '', f.ownerName].filter(Boolean).join(' · ')}</div>
              </div>
              <Button size="sm" variant={canPin(f) ? 'primary' : 'ghost'} disabled={!canPin(f) || (!!pinning && pinning !== f.id)} loading={pinning === f.id} onClick={() => void pin(f)}>
                {canPin(f) ? 'Épingler' : 'Non pris en charge'}
              </Button>
            </div>
          ))}
          {!loading && !items.length && !err && <Empty icon="🔎" title={q ? 'Aucun fichier trouvé' : 'Aucun fichier récent'} />}
          {loading && <div className="cx-center"><Spinner /></div>}
          {next && !loading && <div className="cx-center"><Button size="sm" variant="ghost" onClick={() => void run(true)}>Afficher plus</Button></div>}
        </div>
      )}
      <InlineError>{err}</InlineError>
    </div>
  );
}

export const openDrivePicker = () => openSheet<void>('Épingler un fichier Google Drive', close => <DrivePicker close={() => close()} />, 640);
