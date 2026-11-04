// Panneau latéral « file » : aperçu grand format, lecteur, actions système, pages où le fichier est épinglé.
import { useEffect, useMemo, useState } from 'react';
import type { ID, Page } from '../db/types';
import { repo } from '../db/store';
import { usePages } from '../db/pages';
import { getActiveEditor } from '../editor/active';
import { closeSidePanel, openPage, toast } from '../ui/appState';
import { Button, Empty } from '../ui/kit';
import { backend } from './backend';
import { insertPins } from './insert';
import { fileKind, formatDate, formatSize, KIND_META, kindLabel, plural } from './kinds';
import { FileIcon, FilePreview } from './Preview';
import { attempt, open, relocate, removeFromVault, reveal } from './service';
import { useVault } from './store';
import { usagesOf } from './usages';
import './files.css';

/** Pages (store réactif, ou lecture directe si l'arbre n'est pas encore chargé). */
export function usePagesMap(): Record<ID, Page> {
  const pages = usePages(s => s.pages);
  const loaded = usePages(s => s.loaded);
  const [fallback, setFallback] = useState<Record<ID, Page>>({});
  useEffect(() => {
    if (loaded) return;
    let alive = true;
    repo.listPages().then(list => alive && setFallback(Object.fromEntries(list.map(p => [p.id, p])))).catch(() => {});
    return () => { alive = false; };
  }, [loaded]);
  return loaded ? pages : fallback;
}

export async function copyText(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copié.`, 'success'); }
  catch { toast(`Impossible de copier ${what.toLowerCase()} dans le presse-papiers.`, 'error'); }
}

export function FilePanel({ props }: { props?: Record<string, unknown> }) {
  const hash = typeof props?.hash === 'string' ? props.hash : '';
  const file = useVault(s => s.files[hash]);
  const loaded = useVault(s => s.loaded);
  const pages = usePagesMap();
  const usage = useMemo(() => usagesOf(hash, pages), [hash, pages]);
  const [showHash, setShowHash] = useState(false);

  if (!file) {
    return <div className="fx-panel"><Empty icon="📎" title={loaded ? 'Fichier absent du vault' : 'Chargement…'}>{loaded && "Ce fichier n'est pas (ou plus) dans le vault de cet ordinateur."}</Empty></div>;
  }
  const kind = fileKind(file.name, file.mime);
  const active = getActiveEditor();
  const canPin = !!active && !active.editor.isDestroyed && active.editor.isEditable && !!active.editor.schema.nodes.filePin;
  const live = usage.filter(u => !u.trashed);
  const trashed = usage.length - live.length;
  const isDesktop = backend.mode === 'tauri';

  return (
    <div className="fx-panel" style={{ ['--kind' as string]: KIND_META[kind].color }}>
      <header className="fx-panel-head">
        <FileIcon kind={kind} size={26} tile />
        <div className="fx-panel-title">
          <h2 title={file.name}>{file.name}</h2>
          <div className="fx-panel-meta">
            {kindLabel(file.name, file.mime)} · {formatSize(file.size)}
            <StateBadges file={file} />
          </div>
        </div>
      </header>

      <div className="fx-panel-preview"><FilePreview file={file} size="lg" /></div>

      <div className="fx-panel-actions">
        {!file.missing && <Button variant="primary" onClick={() => attempt(() => open(file.hash, 'system'))}>{isDesktop ? "Ouvrir avec l'app Windows" : 'Ouvrir dans un onglet'}</Button>}
        {isDesktop && !file.missing && <Button onClick={() => attempt(() => reveal(file.hash))}>Afficher dans l'explorateur</Button>}
        {file.missing && isDesktop && <Button variant="primary" onClick={() => attempt(() => relocate(file.hash))}>Relocaliser…</Button>}
        {canPin && active && <Button variant="ghost" onClick={() => insertPins(active.editor, active.editor.state.selection.to, [file])}>Épingler au curseur</Button>}
        {isDesktop && <Button variant="ghost" onClick={() => copyText(file.path, 'Chemin')}>Copier le chemin</Button>}
      </div>

      <section className="fx-panel-section">
        <h3>Épinglé dans</h3>
        {live.length ? (
          <ul className="fx-usage-list">
            {live.map(u => (
              <li key={u.pageId}>
                <button className="fx-usage" onClick={() => openPage(u.pageId)}>
                  <span className="fx-usage-icon">{u.icon || '📄'}</span>
                  <span className="fx-usage-title">{u.title}</span>
                  {u.count > 1 && <span className="fx-usage-count">{u.count}×</span>}
                  {u.inProps && !u.count && <span className="fx-usage-count">propriété</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="muted fx-small">Pas encore épinglé dans une page.</p>}
        {trashed > 0 && <p className="muted fx-small">Aussi dans {plural(trashed, 'page')} de la corbeille.</p>}
      </section>

      <section className="fx-panel-section">
        <h3>Détails</h3>
        <dl className="fx-details">
          <dt>Mode</dt><dd>{file.linked ? "Lien vers l'original (non copié)" : 'Copie dans le vault'}</dd>
          <dt>Emplacement</dt><dd><code className="fx-path" title={file.path}>{isDesktop ? file.path : 'Stockage local du navigateur'}</code></dd>
          {file.originalPath && <><dt>Origine</dt><dd><code className="fx-path" title={file.originalPath}>{file.originalPath}</code></dd></>}
          <dt>Type</dt><dd>{file.mime}</dd>
          <dt>Taille</dt><dd>{formatSize(file.size)} <span className="muted">({file.size.toLocaleString('fr-FR')} octets)</span></dd>
          <dt>Ajouté</dt><dd>{formatDate(file.addedAt)}</dd>
          {file.modifiedAt && <><dt>Modifié</dt><dd>{formatDate(file.modifiedAt)}</dd></>}
          <dt>SHA-256</dt>
          <dd>
            <button className="fx-hash" onClick={() => setShowHash(v => !v)} title="Afficher l'empreinte complète">{showHash ? file.hash : `${file.hash.slice(0, 12)}…`}</button>
            <Button size="sm" variant="ghost" onClick={() => copyText(file.hash, 'Empreinte')}>Copier</Button>
          </dd>
        </dl>
      </section>

      <section className="fx-panel-section fx-panel-danger">
        <Button variant="danger" size="sm" disabled={usage.length > 0}
          title={usage.length ? 'Retire d’abord les puces de ce fichier dans les pages' : undefined}
          onClick={() => attempt(async () => { if (await removeFromVault(file.hash)) closeSidePanel(); })}>
          {file.linked ? 'Retirer du vault' : 'Supprimer du vault'}
        </Button>
        {usage.length > 0 && <span className="muted fx-small">Utilisé dans {plural(usage.length, 'page')} : suppression impossible.</span>}
      </section>
    </div>
  );
}

export function StateBadges({ file }: { file: { linked: boolean; missing?: boolean } }) {
  return (
    <span className="fx-badges">
      {file.missing && <span className="fx-badge is-missing">Introuvable</span>}
      <span className={`fx-badge ${file.linked ? 'is-linked' : 'is-copied'}`}>{file.linked ? 'Lié' : 'Copié'}</span>
    </span>
  );
}
