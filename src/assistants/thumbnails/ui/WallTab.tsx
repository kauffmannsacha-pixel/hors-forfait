// Onglet 2 — Mur d'inspiration : grille filtrable (niche, couleur, émotion, texte, visage, performance), tri, détail.
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Empty, Input, Select } from '../../../ui/kit';
import { nicheList, setTab, useThumbs } from '../state';
import { COLOR_FAMILIES, FAMILY_SWATCH, type ColorFamily } from '../lib/color';
import { recordFamilies } from '../lib/insights';
import { stripAccents } from '../lib/normalize';
import { EMOTIONS, type Emotion, type ThumbRecord } from '../lib/types';
import { Check, Seg } from './common';
import { ThumbCard } from './AnalyzeTab';
import { NicheInsightsCard } from './Insights';
import { ThumbDetail } from './ThumbDetail';

type Tri = 'tous' | 'avec' | 'sans';
type Sort = 'vues' | 'ratio' | 'lisibilite' | 'contraste' | 'couleur' | 'mots' | 'recent';
interface Filters { family: ColorFamily | ''; emotion: Emotion | ''; text: Tri; face: Tri; perf: string; refsOnly: boolean; q: string; sort: Sort }
const DEFAULT: Filters = { family: '', emotion: '', text: 'tous', face: 'tous', perf: '0', refsOnly: false, q: '', sort: 'ratio' };
const LS = 'prisme:thumb:wall-filters';
const readLs = (): Filters => { try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(LS) ?? '{}') }; } catch { return DEFAULT; } };

const SORTS: Record<Sort, { label: string; key: (r: ThumbRecord) => number }> = {
  ratio: { label: 'Vues / abonnés', key: r => r.ratio ?? -1 },
  vues: { label: 'Vues', key: r => r.views },
  lisibilite: { label: 'Lisibilité 168×94', key: r => r.metrics?.scores.legibility ?? -1 },
  contraste: { label: 'Contraste', key: r => r.metrics?.scores.contrast ?? -1 },
  couleur: { label: 'Couleurs vives', key: r => r.metrics?.colorfulness ?? -1 },
  mots: { label: 'Moins de mots', key: r => (r.vision ? -r.vision.wordCount : -99) },
  recent: { label: 'Analyse récente', key: r => r.analyzedAt },
};

export function WallTab() {
  const library = useThumbs(s => s.library);
  const refs = useThumbs(s => s.refs);
  const niche = useThumbs(s => s.wallNiche);
  const [f, setF] = useState<Filters>(readLs);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem(LS, JSON.stringify(f)); } catch { /* stockage indisponible */ } }, [f]);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF(p => ({ ...p, [k]: v }));
  const niches = useMemo(() => nicheList(library), [library]);
  const refSet = useMemo(() => new Set(refs.map(r => r.videoId)), [refs]);

  const shown = useMemo(() => {
    const q = stripAccents(f.q.trim().toLowerCase());
    const minRatio = Number(f.perf);
    return Object.values(library).filter(r => {
      if (niche && r.niche !== niche && !(r.niches ?? []).includes(niche)) return false;
      if (f.refsOnly && !refSet.has(r.videoId)) return false;
      if (f.family && !recordFamilies(r).includes(f.family)) return false;
      if (f.emotion && r.vision?.emotion !== f.emotion) return false;
      if (f.text !== 'tous' && (!r.vision || r.vision.hasText !== (f.text === 'avec'))) return false;
      if (f.face !== 'tous' && (!r.vision || r.vision.face !== (f.face === 'avec'))) return false;
      if (minRatio > 0 && (r.ratio ?? 0) < minRatio) return false;
      if (q && !stripAccents(`${r.title} ${r.channelTitle} ${r.vision?.text ?? ''} ${(r.vision?.elements ?? []).join(' ')}`.toLowerCase()).includes(q)) return false;
      return true;
    }).sort((a, b) => SORTS[f.sort].key(b) - SORTS[f.sort].key(a));
  }, [library, niche, f, refSet]);
  const animate = shown.length <= 150;

  if (!Object.keys(library).length) return <Empty icon="🧱" title="Le mur est vide">Lance une analyse de niche ou de chaîne : chaque miniature analysée rejoint le mur.<div style={{ marginTop: 12 }}><Button variant="primary" onClick={() => setTab('analyse')}>Analyser une niche</Button></div></Empty>;

  return <div className="th-col">
    <div className="glass card th-col" style={{ gap: 10 }}>
      <div className="th-row">
        <Select value={niche} onChange={e => useThumbs.setState({ wallNiche: e.target.value })} style={{ width: 230 }} aria-label="Niche">
          <option value="">Toutes les niches ({Object.keys(library).length})</option>
          {niches.map(n => <option key={n.key} value={n.key}>{n.key} ({n.count})</option>)}
        </Select>
        <Select value={f.emotion} onChange={e => set('emotion', e.target.value as Emotion | '')} style={{ width: 170 }} aria-label="Émotion">
          <option value="">Toutes émotions</option>{EMOTIONS.map(e => <option key={e} value={e}>{e === 'aucune' ? 'sans visage' : e}</option>)}
        </Select>
        <Select value={f.perf} onChange={e => set('perf', e.target.value)} style={{ width: 190 }} aria-label="Performance">
          <option value="0">Toute performance</option><option value="1">≥ ×1 abonnés</option><option value="2">≥ ×2 abonnés</option><option value="5">≥ ×5 abonnés</option><option value="10">≥ ×10 abonnés</option>
        </Select>
        <Select value={f.sort} onChange={e => set('sort', e.target.value as Sort)} style={{ width: 190 }} aria-label="Tri">
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>Tri : {s.label}</option>)}
        </Select>
        <Input value={f.q} onChange={e => set('q', e.target.value)} placeholder="Rechercher (titre, texte, élément…)" style={{ width: 240 }} />
      </div>
      <div className="th-row">
        <span className="th-small th-muted">Texte</span><Seg value={f.text} onChange={v => set('text', v)} options={[{ id: 'tous', label: 'Tous' }, { id: 'avec', label: 'Avec' }, { id: 'sans', label: 'Sans' }]} label="Texte" />
        <span className="th-small th-muted">Visage</span><Seg value={f.face} onChange={v => set('face', v)} options={[{ id: 'tous', label: 'Tous' }, { id: 'avec', label: 'Avec' }, { id: 'sans', label: 'Sans' }]} label="Visage" />
        <Check checked={f.refsOnly} onChange={v => set('refsOnly', v)} label={`★ Références (${refs.length})`} />
      </div>
      <div className="th-row" role="group" aria-label="Couleur dominante">
        <span className="th-small th-muted">Couleur</span>
        <button type="button" className="th-iconbtn" aria-pressed={!f.family} title="Toutes" onClick={() => set('family', '')} style={{ width: 'auto', padding: '0 8px', fontSize: 12.5, background: !f.family ? 'var(--line)' : undefined }}>Toutes</button>
        {COLOR_FAMILIES.map(c => <button key={c} type="button" className="th-iconbtn" title={c} aria-label={c} aria-pressed={f.family === c} onClick={() => set('family', f.family === c ? '' : c)}
          style={{ boxShadow: f.family === c ? '0 0 0 2px var(--accent)' : undefined }}><i className="th-sw" style={{ background: FAMILY_SWATCH[c], width: 16, height: 16 }} /></button>)}
        <span className="th-small th-muted" style={{ marginLeft: 'auto' }}>{shown.length} miniature{shown.length > 1 ? 's' : ''}</span>
        {(f.family || f.emotion || f.text !== 'tous' || f.face !== 'tous' || f.perf !== '0' || f.refsOnly || f.q) && <Button size="sm" variant="ghost" onClick={() => setF({ ...DEFAULT, sort: f.sort })}>Réinitialiser</Button>}
      </div>
    </div>
    {!shown.length ? <Empty icon="🫥" title="Aucune miniature ne correspond">Assouplis les filtres.</Empty>
      : <div className="th-wall">
        <AnimatePresence initial={false}>
          {shown.map(r => animate
            ? <motion.div key={r.videoId} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ type: 'spring', bounce: 0, duration: 0.35 }}>
              <ThumbCard rec={r} starred={refSet.has(r.videoId)} onOpen={() => setOpen(r.videoId)} />
            </motion.div>
            : <div key={r.videoId}><ThumbCard rec={r} starred={refSet.has(r.videoId)} onOpen={() => setOpen(r.videoId)} /></div>)}
        </AnimatePresence>
      </div>}
    {niche && <NicheInsightsCard niche={niche} />}
    <ThumbDetail videoId={open} onClose={() => setOpen(null)} />
  </div>;
}
