// Vue « Fichiers » : tout le vault en grille ou en liste, filtres, recherche, tri, taille totale,
// pages où chaque fichier est épinglé, badges lié/copié/introuvable, relocaliser, supprimer.
import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { openPage, openSidePanel } from '../ui/appState';
import { Button, Empty, Input, Select } from '../ui/kit';
import { backend } from './backend';
import { fileJob, useDropUi } from './dragDrop';
import { filterFiles, SORTS, sortFiles, vaultStats, type SortKey, type StateFilter, type VaultEntry } from './indexLogic';
import { fileKind, formatDate, formatSize, groupOf, KIND_GROUPS, kindLabel, plural, truncateMiddle, type KindGroup } from './kinds';
import { importJobs } from './jobs';
import { FileIcon, Thumb } from './Preview';
import { StateBadges, usePagesMap } from './FilePanel';
import { attempt, importPicked, open, pickedName, recheck, relocate, removeFromVault, reveal, useFilesViewPrefs } from './service';
import { setLinkByDefault, useVault } from './store';
import { usageIndex, type Usage } from './usages';
import './files.css';

const PREFS_KEY = 'prisme:files:view';
type Layout = 'grid' | 'list';
function readPrefs(): { layout: Layout; sort: SortKey } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { layout?: Layout; sort?: SortKey };
    return { layout: p.layout === 'list' ? 'list' : 'grid', sort: SORTS.some(s => s.id === p.sort) ? (p.sort as SortKey) : 'recent' };
  } catch { return { layout: 'grid', sort: 'recent' }; }
}

const ICONS = {
  open: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>',
  locate: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  grid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>',
};
const Svg = ({ html }: { html: string }) => <span className="fx-svg" dangerouslySetInnerHTML={{ __html: html }} />;

function IconAction({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" className={`fx-iconbtn${danger ? ' is-danger' : ''}`} title={label} aria-label={label} onClick={(e: MouseEvent) => { e.stopPropagation(); onClick(); }}><Svg html={icon} /></button>;
}

function Actions({ f, used }: { f: VaultEntry; used: number }) {
  const desktop = backend.mode === 'tauri';
  return (
    <div className="fx-actions">
      {!f.missing && <IconAction icon={ICONS.open} label={desktop ? "Ouvrir avec l'app Windows" : 'Ouvrir dans un onglet'} onClick={() => attempt(() => open(f.hash, 'system'))} />}
      {desktop && !f.missing && <IconAction icon={ICONS.folder} label="Afficher dans l'explorateur" onClick={() => attempt(() => reveal(f.hash))} />}
      {desktop && f.missing && <IconAction icon={ICONS.locate} label="Relocaliser…" onClick={() => attempt(() => relocate(f.hash))} />}
      {used === 0 && <IconAction icon={ICONS.trash} danger label={f.linked ? 'Retirer du vault' : 'Supprimer du vault'} onClick={() => attempt(() => removeFromVault(f.hash))} />}
    </div>
  );
}

function PageChips({ usage, max }: { usage: Usage[]; max: number }) {
  const live = usage.filter(u => !u.trashed);
  if (!live.length) return <span className="fx-unused">{usage.length ? 'Seulement dans la corbeille' : 'Non épinglé'}</span>;
  return (
    <span className="fx-page-chips">
      {live.slice(0, max).map(u => (
        <button key={u.pageId} type="button" className="fx-page-chip" title={`Ouvrir « ${u.title} »`} onClick={e => { e.stopPropagation(); openPage(u.pageId); }}>
          <span>{u.icon || '📄'}</span><span className="fx-page-chip-title">{u.title}</span>
        </button>
      ))}
      {live.length > max && <span className="fx-page-more" title={live.slice(max).map(u => u.title).join(', ')}>+{live.length - max}</span>}
    </span>
  );
}

export function FilesView() {
  const files = useVault(s => s.files);
  const loaded = useVault(s => s.loaded);
  const linkByDefault = useVault(s => s.linkByDefault);
  const stateFilter = useFilesViewPrefs(s => s.state);
  const overVault = useDropUi(s => s.overVault);
  const pages = usePagesMap();
  const usage = useMemo(() => usageIndex(pages), [pages]);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<KindGroup>('all');
  const [{ layout, sort }, setPrefs] = useState(readPrefs);
  const [checking, setChecking] = useState(false);
  const [html5Over, setHtml5Over] = useState(false);
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ layout, sort })); } catch { /* stockage indisponible */ } }, [layout, sort]);

  const all = useMemo(() => Object.values(files), [files]);
  const stats = useMemo(() => vaultStats(all), [all]);
  const usedCount = (h: string) => usage.get(h)?.length ?? 0;
  const groupCounts = useMemo(() => {
    const c: Partial<Record<KindGroup, number>> = { all: all.length };
    for (const f of all) { const g = groupOf(fileKind(f.name, f.mime)); c[g] = (c[g] ?? 0) + 1; }
    return c;
  }, [all]);
  const shown = useMemo(
    () => sortFiles(filterFiles(all, { query, group, state: stateFilter, usageCount: usedCount }), sort, usedCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, query, group, stateFilter, sort, usage]);
  const desktop = backend.mode === 'tauri';

  const pick = (link: boolean) => attempt(async () => {
    const picked = await backend.pick({ multiple: true, title: link ? 'Lier des fichiers (sans copie)' : 'Ajouter des fichiers au vault' });
    await importJobs(picked.map(p => ({ name: pickedName(p), run: onProgress => importPicked(p, link, onProgress) })));
  });
  const doCheck = () => { setChecking(true); recheck().finally(() => setChecking(false)); };

  // Dépôt HTML5 (navigateur, ou Tauri sans glisser natif) ; le dépôt natif Tauri est géré globalement.
  const onDragOver = (e: DragEvent) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); setHtml5Over(true); } };
  const onDrop = (e: DragEvent) => {
    setHtml5Over(false);
    const list = Array.from(e.dataTransfer.files ?? []);
    if (!list.length) return;
    e.preventDefault();
    importJobs(list.map(f => fileJob(f)));
  };

  return (
    <div className={`fx-view${overVault || html5Over ? ' is-drop' : ''}`} data-files-dropzone onDragOver={onDragOver} onDragLeave={() => setHtml5Over(false)} onDrop={onDrop}>
      <header className="fx-view-head">
        <div>
          <h1>Fichiers</h1>
          <p className="muted fx-view-sub">
            {plural(stats.count, 'fichier')} · {formatSize(stats.totalSize)}
            {stats.linkedCount > 0 && <> · {plural(stats.linkedCount, 'lié', 'liés')} (hors vault)</>}
            {stats.copiedSize !== stats.totalSize && <> · {formatSize(stats.copiedSize)} copiés dans le vault</>}
          </p>
        </div>
        <div className="fx-view-cta">
          {desktop && (
            <div className="tabs" role="radiogroup" aria-label="Mode de dépôt par défaut" title="Mode utilisé quand on glisse un fichier (Alt inverse ce choix)">
              <button type="button" role="radio" aria-checked={!linkByDefault} className={!linkByDefault ? 'tab active' : 'tab'} onClick={() => setLinkByDefault(false)}>Copier</button>
              <button type="button" role="radio" aria-checked={linkByDefault} className={linkByDefault ? 'tab active' : 'tab'} onClick={() => setLinkByDefault(true)}>Lier</button>
            </div>
          )}
          {desktop && <Button onClick={() => pick(true)}>Lier…</Button>}
          <Button variant="primary" onClick={() => pick(false)}>Importer…</Button>
        </div>
      </header>

      {stats.missingCount > 0 && (
        <div className="fx-banner glass" role="status">
          <span className="fx-banner-text"><b>{plural(stats.missingCount, 'fichier introuvable', 'fichiers introuvables')}</b> — déplacé{stats.missingCount > 1 ? 's' : ''} ou supprimé{stats.missingCount > 1 ? 's' : ''} depuis l'épinglage.</span>
          {stateFilter !== 'missing' && <Button size="sm" onClick={() => useFilesViewPrefs.setState({ state: 'missing' })}>Afficher</Button>}
          <Button size="sm" variant="ghost" loading={checking} onClick={doCheck}>Revérifier</Button>
        </div>
      )}

      <div className="fx-toolbar">
        <Input className="fx-search" type="search" placeholder="Rechercher un fichier…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Rechercher" />
        <Select value={stateFilter} onChange={e => useFilesViewPrefs.setState({ state: e.target.value as StateFilter })} aria-label="État">
          <option value="all">Tous les états</option>
          <option value="copied">Copiés</option>
          <option value="linked">Liés</option>
          <option value="missing">Introuvables</option>
          <option value="unused">Non épinglés</option>
        </Select>
        <Select value={sort} onChange={e => setPrefs(p => ({ ...p, sort: e.target.value as SortKey }))} aria-label="Trier par">
          {SORTS.map(s => <option key={s.id} value={s.id}>Trier : {s.label}</option>)}
        </Select>
        <div className="tabs fx-layout" role="radiogroup" aria-label="Affichage">
          <button type="button" role="radio" aria-checked={layout === 'grid'} title="Grille" className={layout === 'grid' ? 'tab active' : 'tab'} onClick={() => setPrefs(p => ({ ...p, layout: 'grid' }))}><Svg html={ICONS.grid} /></button>
          <button type="button" role="radio" aria-checked={layout === 'list'} title="Liste" className={layout === 'list' ? 'tab active' : 'tab'} onClick={() => setPrefs(p => ({ ...p, layout: 'list' }))}><Svg html={ICONS.list} /></button>
        </div>
      </div>

      <div className="fx-chips" role="tablist" aria-label="Type de fichier">
        {KIND_GROUPS.filter(g => g.id === 'all' || groupCounts[g.id]).map(g => (
          <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={`fx-filter${group === g.id ? ' is-on' : ''}`} onClick={() => setGroup(g.id)}>
            {g.label}<span className="fx-filter-count">{groupCounts[g.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {!loaded ? <Empty icon="⏳" title="Chargement du vault…" />
        : !all.length ? (
          <Empty icon="📎" title="Aucun fichier pour l'instant">
            Glisse un fichier (PDF, image, vidéo, .lua, .psd…) directement dans une phrase d'une page, ou dépose-le ici.
            {desktop && <> Maintiens <kbd>Alt</kbd> en déposant pour le lier au lieu de le copier.</>}
          </Empty>
        ) : !shown.length ? <Empty icon="🔍" title="Aucun fichier ne correspond">Essaie une autre recherche ou un autre filtre.</Empty>
        : layout === 'grid' ? (
          <div className="fx-grid">
            {shown.map(f => {
              const u = usage.get(f.hash) ?? [];
              return (
                <div key={f.hash} className={`fx-card glass${f.missing ? ' is-missing' : ''}`} role="button" tabIndex={0}
                  onClick={() => openSidePanel('file', { hash: f.hash })}
                  onKeyDown={e => { if (e.key === 'Enter') openSidePanel('file', { hash: f.hash }); }}>
                  <Thumb file={f} />
                  <div className="fx-card-body">
                    <div className="fx-card-name" title={f.name}>{truncateMiddle(f.name, 30)}</div>
                    <div className="fx-card-meta">{kindLabel(f.name, f.mime)} · {formatSize(f.size)}</div>
                    <div className="fx-card-row"><StateBadges file={f} /></div>
                    <div className="fx-card-row"><PageChips usage={u} max={2} /></div>
                  </div>
                  <Actions f={f} used={u.length} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="fx-list glass" role="table">
            <div className="fx-row fx-row-head" role="row">
              <span role="columnheader">Nom</span><span role="columnheader">Type</span><span role="columnheader">Taille</span>
              <span role="columnheader">Épinglé dans</span><span role="columnheader">Ajouté</span><span />
            </div>
            {shown.map(f => {
              const u = usage.get(f.hash) ?? [];
              const kind = fileKind(f.name, f.mime);
              return (
                <div key={f.hash} className={`fx-row${f.missing ? ' is-missing' : ''}`} role="row" tabIndex={0}
                  onClick={() => openSidePanel('file', { hash: f.hash })}
                  onKeyDown={e => { if (e.key === 'Enter') openSidePanel('file', { hash: f.hash }); }}>
                  <span className="fx-row-name" role="cell">
                    <FileIcon kind={kind} size={18} />
                    <span className="fx-row-text"><span title={f.name}>{f.name}</span><StateBadges file={f} /></span>
                  </span>
                  <span role="cell" className="muted">{kindLabel(f.name, f.mime)}</span>
                  <span role="cell" className="muted fx-num">{formatSize(f.size)}</span>
                  <span role="cell"><PageChips usage={u} max={3} /></span>
                  <span role="cell" className="muted">{formatDate(f.addedAt)}</span>
                  <Actions f={f} used={u.length} />
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
