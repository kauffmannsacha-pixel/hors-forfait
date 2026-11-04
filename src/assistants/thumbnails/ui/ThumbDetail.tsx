// Détail d'une miniature analysée : image + surcouches, mesures, analyse Vision, performance, actions.
import { useState } from 'react';
import { Button, Chip, Sheet } from '../../../ui/kit';
import { confirmAction, toast } from '../../../ui/appState';
import { files } from '../../../files/api';
import { removeRecords, sendToGenerator, setRef, useThumbs } from '../state';
import { blobToBytes, fetchImageBlob, ytThumbUrl } from '../lib/browserImage';
import { wcagLevel } from '../lib/color';
import { formatAgo, formatDuration, formatNum, formatViews, ratioLabel } from '../lib/format';
import { fmtRatio } from '../lib/metrics';
import { reanalyzeOne } from '../lib/pipeline';
import { Check, Citations, errText, FocalMarker, Meter, openExternal, PaletteBar, SaliencyOverlay } from './common';


export function ThumbDetail({ videoId, onClose }: { videoId: string | null; onClose: () => void }) {
  const rec = useThumbs(s => (videoId ? s.library[videoId] : undefined));
  const isRef = useThumbs(s => !!videoId && s.refs.some(r => r.videoId === videoId));
  const [heat, setHeat] = useState(false);
  const [focal, setFocal] = useState(true);
  const [busy, setBusy] = useState<'' | 'ref' | 'again'>('');
  if (!videoId || !rec) return null;
  const m = rec.metrics, v = rec.vision;

  const toggleRef = async () => {
    setBusy('ref');
    try {
      if (isRef) { await setRef(rec.videoId, false); toast('Retirée des références.'); return; }
      let fileHash: string | undefined;
      try {
        const blob = await fetchImageBlob(rec.imageUrl || ytThumbUrl(rec.videoId));
        fileHash = (await files.importBytes(`reference-${rec.videoId}.jpg`, blob.type || 'image/jpeg', await blobToBytes(blob))).hash;
      } catch { /* le vault n'est pas indispensable pour garder la référence */ }
      await setRef(rec.videoId, true, { fileHash });
      toast(fileHash ? 'Gardée comme référence (copie dans le vault).' : 'Gardée comme référence.', 'success');
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(''); }
  };
  const again = async () => { setBusy('again'); try { await reanalyzeOne(rec.videoId); toast('Miniature ré-analysée.', 'success'); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(''); } };
  const remove = async () => {
    if (!(await confirmAction(`Retirer « ${rec.title} » du mur d'inspiration ? Son analyse en cache sera supprimée.`, { danger: true, confirmLabel: 'Retirer' }))) return;
    removeRecords([rec.videoId]); onClose();
  };

  return <Sheet open onClose={onClose} width={1020} title={<span style={{ letterSpacing: '-.01em' }}>{rec.title}</span>}>
    <div className="th-split-r" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px' }}>
      <div className="th-col">
        <div className="th-thumb">
          <img src={rec.imageUrl || ytThumbUrl(rec.videoId)} alt={`Miniature : ${rec.title}`} />
          {heat && m && <SaliencyOverlay saliency={m.saliency} />}
          {focal && m && <FocalMarker x={m.focal.x} y={m.focal.y} />}
          {focal && v && <FocalMarker x={v.focalPoint.x} y={v.focalPoint.y} vision />}
          <span className="th-dur">{formatDuration(rec.durationSec)}</span>
        </div>
        <div className="th-row">
          <Check checked={heat} onChange={setHeat} label="Carte de saillance" disabled={!m} />
          <Check checked={focal} onChange={setFocal} label="Points focaux (blanc : mesuré · jaune : Claude)" />
        </div>
        <div className="th-row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div className="th-tiny th-muted">Taille réelle dans les suggestions (168×94)</div>
            <img src={ytThumbUrl(rec.videoId, 'mqdefault')} width={168} height={94} style={{ borderRadius: 8, display: 'block', marginTop: 4 }} alt="" />
          </div>
          {m && <div style={{ flex: 1, minWidth: 220 }}>
            <div className="th-tiny th-muted" style={{ marginBottom: 4 }}>Couleurs dominantes (k-means)</div>
            <PaletteBar palette={m.palette} />
          </div>}
        </div>
        {v && <div className="th-col" style={{ gap: 6 }}>
          <div className="th-section-title" style={{ margin: '8px 0 0' }}>Pourquoi ça marche (Claude Vision)</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>{v.whyItWorks.map((w, i) => <li key={i}>{w}</li>)}</ul>
          {v.weaknesses.length > 0 && <><div className="th-small th-strong" style={{ marginTop: 6 }}>Points faibles</div><ul style={{ margin: 0, paddingLeft: 18 }} className="th-small">{v.weaknesses.map((w, i) => <li key={i}>{w}</li>)}</ul></>}
          {v.curiosity && <div className="th-note">❓ {v.curiosity}</div>}
          <Citations list={v.citations} />
        </div>}
        {rec.visionError && <div className="th-error">Vision : {rec.visionError}</div>}
        {rec.metricsError && <div className="th-error">Mesures : {rec.metricsError}</div>}
      </div>
      <div className="th-col">
        <div className="th-small">
          <div className="th-strong">{rec.channelTitle}</div>
          <div className="th-muted">{formatViews(rec.views)} · {formatAgo(rec.publishedAt)}</div>
          <div style={{ marginTop: 4 }}>Performance : <b>{ratioLabel(rec.ratio)}</b> <span className="th-muted">vues/abonnés{rec.subscribers ? ` (${formatNum(rec.subscribers)} abonnés)` : ''}</span></div>
          <div className="th-muted th-tiny">Niche : {[rec.niche, ...(rec.niches ?? []).filter(n => n !== rec.niche)].join(' · ')}</div>
        </div>
        {v && <div className="th-chips">
          <Chip>{v.face ? `${v.faceCount} visage${v.faceCount > 1 ? 's' : ''} · ${v.emotion} ${v.emotionIntensity}/10` : 'Sans visage'}</Chip>
          <Chip>{v.hasText ? `« ${v.text} » · ${v.wordCount} mot${v.wordCount > 1 ? 's' : ''}` : 'Sans texte'}</Chip>
          <Chip>{v.elementCount} élément{v.elementCount > 1 ? 's' : ''}</Chip>
          <Chip>{v.layout}</Chip>
        </div>}
        {v && <dl className="th-small" style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '4px 8px', margin: 0 }}>
          <dt className="th-muted">Composition</dt><dd style={{ margin: 0 }}>{v.composition}</dd>
          <dt className="th-muted">Éléments</dt><dd style={{ margin: 0 }}>{v.elements.join(', ') || '–'}</dd>
          <dt className="th-muted">Point focal</dt><dd style={{ margin: 0 }}>{v.focalPoint.description || '–'}</dd>
          <dt className="th-muted">Fond</dt><dd style={{ margin: 0 }}>{v.background || '–'}</dd>
          <dt className="th-muted">Couleurs</dt><dd style={{ margin: 0 }}>{v.colorStrategy || '–'}</dd>
        </dl>}
        {m && <div>
          <div className="th-section-title" style={{ marginTop: 4 }}>Mesures locales</div>
          <Meter label="Lisibilité 168×94" value={m.scores.legibility} hint="Contraste et structure qui survivent à la réduction" />
          <Meter label="Contraste" value={m.scores.contrast} />
          <Meter label="Point focal" value={m.scores.focus} />
          <Meter label="Couleur" value={m.scores.color} />
          <Meter label="Netteté" value={m.scores.sharpness} />
          <div className="th-tiny th-muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
            Sujet/fond : {fmtRatio(m.focalContrast)} (WCAG {wcagLevel(m.focalContrast, true)}) · en petit : {fmtRatio(m.legibility.contrastRatio)}<br />
            Luminosité L* {Math.round(m.luminance.mean)} · écart-type {Math.round(m.rmsContrast * 100)} · colorfulness {Math.round(m.colorfulness)} · saturation {Math.round(m.saturation * 100)} %<br />
            Netteté {Math.round(m.sharpness)} · {m.focal.blobs} zone(s) saillante(s) · focus {Math.round(m.focal.concentration * 100)} % ({m.thirds})
          </div>
        </div>}
        <div className="th-col" style={{ gap: 6, marginTop: 4 }}>
          <Button variant={isRef ? 'secondary' : 'primary'} loading={busy === 'ref'} onClick={toggleRef}>{isRef ? '★ Référence gardée — retirer' : '☆ Garder comme référence'}</Button>
          <Button onClick={() => { void setRef(rec.videoId, true); sendToGenerator({ niche: rec.niche, useRefs: true }); onClose(); }}>S'en inspirer dans le générateur</Button>
          <div className="th-row">
            <Button size="sm" variant="ghost" onClick={() => void openExternal(`https://www.youtube.com/watch?v=${rec.videoId}`)}>Ouvrir la vidéo ↗</Button>
            <Button size="sm" variant="ghost" loading={busy === 'again'} onClick={again}>Ré-analyser</Button>
            <Button size="sm" variant="ghost" onClick={remove}>Retirer</Button>
          </div>
          <div className="th-tiny th-muted">Analysée {formatAgo(rec.analyzedAt)}{m ? ` · ${m.width}×${m.height}` : ''}{rec.imageUrl.includes('hqdefault') ? ' · repli hqdefault (bandes retirées)' : ''}</div>
        </div>
      </div>
    </div>
  </Sheet>;
}
