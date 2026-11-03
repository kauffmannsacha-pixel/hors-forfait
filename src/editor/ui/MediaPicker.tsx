import { useState } from 'react';
import { Tabs } from '../../ui/kit';
import { toast } from '../../ui/appState';
import { chooseLocalMedia, importBrowserFile, guessMime, MEDIA_LABEL, type MediaKind, type MediaResult } from '../media';

/** Sélecteur de média : import local (vault) ou lien. `embed` = lien uniquement. */
export function MediaPicker({ media, onDone }: { media: MediaKind | 'embed'; onDone: (r: MediaResult) => void }) {
  const [tab, setTab] = useState<'upload' | 'link'>(media === 'embed' ? 'link' : 'upload');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const label = media === 'embed' ? 'Intégration' : MEDIA_LABEL[media];

  const choose = async () => {
    if (media === 'embed') return;
    setBusy(true);
    try { const r = await chooseLocalMedia(media); if (r) onDone(r); }
    catch (e) { toast((e as Error).message || 'Import impossible.', 'error'); }
    finally { setBusy(false); }
  };
  const submitLink = () => {
    const v = url.trim();
    if (!/^(https?:|data:|asset:|blob:)/i.test(v)) { toast('Saisis une adresse complète (https://…).', 'warning'); return; }
    const name = decodeURIComponent(v.split(/[?#]/)[0].split('/').pop() || v);
    onDone({ src: v, name, mime: guessMime(name) });
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files?.[0]; if (!f) return;
    setBusy(true);
    try { onDone(await importBrowserFile(f)); } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="media-picker">
      {media !== 'embed' && <Tabs value={tab} onChange={setTab} tabs={[{ id: 'upload', label: 'Importer' }, { id: 'link', label: 'Lien' }]} />}
      {tab === 'upload' && media !== 'embed' ? (
        <div className={`drop-zone${over ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={choose}>{busy ? 'Import…' : `Choisir : ${label.toLowerCase()}`}</button>
          <span className="muted">ou dépose un fichier ici</span>
        </div>
      ) : (
        <div className="media-link">
          <input className="input" autoFocus placeholder={media === 'embed' ? 'Colle un lien (YouTube, Vimeo, Figma, Loom, Google Maps…)' : 'https://…'} value={url}
            onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitLink(); } }} />
          <button type="button" className="btn btn-primary btn-sm" onClick={submitLink}>{media === 'embed' ? 'Intégrer' : 'Insérer'}</button>
        </div>
      )}
    </div>
  );
}
