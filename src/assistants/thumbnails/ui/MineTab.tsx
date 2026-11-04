// Onglet 3 — Analyse de MA miniature : dépôt (ou vault) → score /10, retours précis sourcés, aperçu dans un fil simulé.
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Score, Spinner } from '../../../ui/kit';
import { toast } from '../../../ui/appState';
import { files } from '../../../files/api';
import { nicheList, sendToAb, sendToEditor, useThumbs, type Inbox } from '../state';
import { blobToBytes, imageFromDataTransfer, vaultBlob } from '../lib/browserImage';
import { fmtRatio } from '../lib/metrics';
import { analyzeMyThumbnail, buildReasons, type FullAnalysis, type ReasonItem } from '../lib/score';
import { loadMine, saveMine } from '../lib/store';
import type { MyAnalysis } from '../lib/types';
import { formatAgo } from '../lib/format';
import { Check, Citations, DropZone, errText, FocalMarker, Meter, PaletteBar, SaliencyOverlay, useObjectUrl, VaultPicker } from './common';
import { FeedPreview } from './FeedPreview';

const ICON = { faible: '!', moyen: '~', bon: '✓' } as const;
export function ReasonList({ items }: { items: ReasonItem[] }) {
  return <div className="th-feedback">{items.map((r, i) => <div key={i} className={`th-fb ${r.level}`}>
    <span className="th-ic" aria-label={r.level}>{ICON[r.level]}</span>
    <div>{r.text} <span className="th-tiny th-muted">· {r.source === 'vision' ? 'Claude Vision' : 'mesure locale'}</span><Citations list={r.citations} /></div>
  </div>)}</div>;
}

export function MineTab() {
  const inbox = useThumbs(s => s.mineInbox);
  const library = useThumbs(s => s.library);
  const [input, setInput] = useState<Inbox | null>(null);
  const [title, setTitle] = useState('');
  const [niche, setNiche] = useState('');
  const [vision, setVision] = useState(true);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<(MyAnalysis & { items: ReasonItem[] }) | null>(null);
  const [history, setHistory] = useState<MyAnalysis[]>([]);
  const [heat, setHeat] = useState(false);
  const [picker, setPicker] = useState(false);
  const url = useObjectUrl(input?.blob);
  const niches = useMemo(() => nicheList(library), [library]);

  useEffect(() => { loadMine().then(setHistory).catch(() => undefined); }, []);
  useEffect(() => { if (inbox) { setInput(inbox); setRes(null); useThumbs.setState({ mineInbox: null }); } }, [inbox]);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => { if (useThumbs.getState().tab !== 'mine') return; const f = imageFromDataTransfer(e.clipboardData); if (f) { setInput({ blob: f, name: f.name || 'collée.png' }); setRes(null); } };
    window.addEventListener('paste', onPaste); return () => window.removeEventListener('paste', onPaste);
  }, []);

  const pickVault = async (hash: string, name: string) => { try { setInput({ blob: await vaultBlob(hash), name, hash }); setRes(null); } catch (e) { toast(errText(e), 'error'); } };
  const analyze = async () => {
    if (!input) return;
    setBusy(true);
    try {
      let hash = input.hash;
      if (!hash) { try { hash = (await files.importBytes(input.name || 'miniature.png', input.blob.type || 'image/png', await blobToBytes(input.blob))).hash; setInput({ ...input, hash }); } catch { /* vault indisponible : analyse quand même */ } }
      const a: FullAnalysis = await analyzeMyThumbnail({ blob: input.blob, name: input.name, hash, title, niche, vision });
      setRes(a);
      const entry: MyAnalysis = { id: a.id, at: a.at, name: a.name, hash: a.hash, title: a.title, niche: a.niche, metrics: a.metrics, critique: a.critique, critiqueError: a.critiqueError, score: a.score, reasons: a.reasons, citations: a.citations };
      const next = [entry, ...history.filter(h => h.id !== entry.id)].slice(0, 40);
      setHistory(next); void saveMine(next);
      if (a.critiqueError) toast(`Claude Vision indisponible : ${a.critiqueError}`, 'warning');
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const openPast = async (h: MyAnalysis) => {
    setRes({ ...h, items: buildReasons(h.metrics, h.critique, []) });
    setTitle(h.title ?? ''); setNiche(h.niche ?? '');
    if (h.hash) await pickVault(h.hash, h.name);
    setRes({ ...h, items: buildReasons(h.metrics, h.critique, []) });
  };

  const m = res?.metrics, c = res?.critique;
  return <div className="th-col">
    <div className="th-split">
      <div className="th-col th-sticky">
        <Card title="Ma miniature">
          {url ? <div className="th-thumb" style={{ marginBottom: 10 }}><img src={url} alt="Ma miniature" />{heat && m && <SaliencyOverlay saliency={m.saliency} />}{m && <FocalMarker x={m.focal.x} y={m.focal.y} />}{c && <FocalMarker x={c.focalPoint.x} y={c.focalPoint.y} vision />}</div> : null}
          <DropZone compact={!!url} onFile={f => { setInput({ blob: f, name: f.name }); setRes(null); }} title={url ? 'Remplacer l\'image' : 'Dépose ta miniature ici'} hint="PNG, JPEG ou WebP — ou colle-la (Ctrl+V)" />
          <div className="th-row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => setPicker(true)}>Choisir dans le vault</Button>{m && <Check checked={heat} onChange={setHeat} label="Saillance" />}</div>
          <hr className="th-hr" />
          <Field label="Titre prévu" hint="Pour juger la cohérence titre ↔ miniature."><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="ex. J'ai survécu 100 jours…" /></Field>
          <Field label="Niche (concurrents)">
            <Input list="th-niches" value={niche} onChange={e => setNiche(e.target.value)} placeholder="ex. minecraft survie" />
            <datalist id="th-niches">{niches.map(n => <option key={n.key} value={n.key} />)}</datalist>
          </Field>
          <Check checked={vision} onChange={setVision} label="Critique Claude Vision (sinon : mesures seules)" />
          <Button variant="primary" disabled={!input} loading={busy} onClick={analyze} style={{ marginTop: 8 }}>Analyser</Button>
        </Card>
        {history.length > 0 && <Card title="Analyses précédentes">
          <div className="th-col" style={{ gap: 4 }}>{history.slice(0, 8).map(h => <button key={h.id} type="button" className="th-layer th-press" style={{ border: 0, background: 'none', color: 'var(--fg)', textAlign: 'left', gridTemplateColumns: '54px 1fr' }} onClick={() => void openPast(h)}>
            <Score value={h.score} /><span className="th-lname">{h.title || h.name} <span className="th-muted th-tiny">· {formatAgo(h.at)}</span></span>
          </button>)}</div>
        </Card>}
      </div>
      <div className="th-col">
        {!res && !busy && <Card><Empty icon="🎯" title="Score /10 et retours précis">Dépose ta miniature : mesures locales (contraste, couleurs, netteté, saillance, lisibilité en 168×94) + critique de Claude Vision appuyée sur les principes sourcés, puis aperçu dans un fil simulé parmi tes concurrents.</Empty></Card>}
        {busy && <Card><div className="th-row"><Spinner /> Mesures locales et critique de Claude Vision…</div></Card>}
        {res && <Card>
          <div className="th-between" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="th-scorebig"><b>{res.score.toFixed(1).replace('.', ',')}</b><span>/10</span></div>
              <div className="th-small th-muted">{c && m ? '60 % Claude Vision + 40 % mesures locales' : c ? 'Claude Vision' : 'Mesures locales uniquement'}</div>
            </div>
            <div className="th-row">
              {input && <Button size="sm" onClick={() => sendToEditor({ image: input })}>Retoucher dans l'éditeur</Button>}
              {input && <Button size="sm" onClick={() => sendToAb(input)}>Ajouter comme version A/B</Button>}
            </div>
          </div>
          {c?.verdict && <p style={{ fontSize: 16, fontWeight: 550, letterSpacing: '-.01em' }}>{c.verdict}</p>}
          {res.critiqueError && <div className="th-note">Claude Vision : {res.critiqueError}</div>}
          {m && <div style={{ marginTop: 8 }}>
            <Meter label="Lisibilité 168×94" value={m.scores.legibility} /><Meter label="Contraste" value={m.scores.contrast} /><Meter label="Point focal" value={m.scores.focus} /><Meter label="Couleur" value={m.scores.color} /><Meter label="Netteté" value={m.scores.sharpness} />
          </div>}
          {c && c.quickWins.length > 0 && <><div className="th-section-title">Retouches prioritaires</div><ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>{c.quickWins.map((w, i) => <li key={i}>{w}</li>)}</ol></>}
          <div className="th-section-title">Retours détaillés</div>
          <ReasonList items={res.items} />
          {c && (c.titleSynergy || c.smallSize) && <div className="th-col" style={{ gap: 6, marginTop: 10 }}>
            {c.titleSynergy && <div className="th-note"><b>Titre ↔ miniature :</b> {c.titleSynergy}</div>}
            {c.smallSize && <div className="th-note"><b>En petit format :</b> {c.smallSize}</div>}
          </div>}
          {!res.citations.length && <div className="th-tiny th-muted" style={{ marginTop: 8 }}>Aucun principe sourcé disponible : mets à jour la base de connaissances pour des conseils cités.</div>}
        </Card>}
        {res && m && url && <Card title="Rendu en petit format">
          <div className="th-row" style={{ alignItems: 'flex-end', gap: 18 }}>
            <div><img src={url} width={168} height={94} style={{ objectFit: 'cover', borderRadius: 8, display: 'block' }} alt="" /><div className="th-tiny th-muted">168×94 (suggestions)</div></div>
            <div><img src={url} width={246} height={138} style={{ objectFit: 'cover', borderRadius: 10, display: 'block' }} alt="" /><div className="th-tiny th-muted">246×138 (recherche)</div></div>
            <div className="th-small" style={{ flex: 1, minWidth: 200 }}>Sujet/fond en petit : <b>{fmtRatio(m.legibility.contrastRatio)}</b> · contraste RMS {Math.round(m.legibility.rms * 100)} · structure {Math.round(m.legibility.edge * 1000)}<div style={{ marginTop: 8 }}><PaletteBar palette={m.palette} /></div></div>
          </div>
        </Card>}
      </div>
    </div>
    {url && <Card title="Aperçu dans un fil vidéo simulé"><FeedPreview mineUrl={url} title={title} niche={niche} /></Card>}
    <VaultPicker open={picker} onClose={() => setPicker(false)} onPick={f => void pickVault(f.hash, f.name)} />
  </div>;
}
