// Synthèse d'une niche : distributions (émotions, couleurs, compositions), ce qui surperforme, règles Claude.
import { useEffect, useState } from 'react';
import { Button, Card } from '../../../ui/kit';
import { toast } from '../../../ui/appState';
import { inNiche, useThumbs } from '../state';
import { FAMILY_SWATCH, type ColorFamily } from '../lib/color';
import { fr1, pct, ratioLabel, formatNum } from '../lib/format';
import { nicheInsights, type Share } from '../lib/insights';
import { loadSyntheses, saveSyntheses } from '../lib/store';
import { synthesizeNiche, thumbnailPrinciples } from '../lib/vision';
import { Citations, errText } from './common';

function Dist({ items, color, max = 6 }: { items: Share[]; color?: (k: string) => string; max?: number }) {
  if (!items.length) return <div className="th-small th-muted">Pas encore de données.</div>;
  return <div>{items.slice(0, max).map(s => <div key={s.key} className="th-dist">
    <span className="th-row" style={{ gap: 6 }}>{color && <i className="th-sw" style={{ background: color(s.key) }} />}{s.key}</span>
    <div className="th-track"><div className="th-fill" style={{ width: `${s.share * 100}%`, background: 'var(--accent)' }} /></div>
    <span className="th-num th-muted" style={{ textAlign: 'right' }}>{Math.round(s.share * 100)} %</span>
  </div>)}</div>;
}

export function NicheInsightsCard({ niche }: { niche: string }) {
  const library = useThumbs(s => s.library);
  const synth = useThumbs(s => s.syntheses[niche]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!Object.keys(useThumbs.getState().syntheses).length) loadSyntheses().then(syntheses => useThumbs.setState(s => ({ syntheses: { ...syntheses, ...s.syntheses } }))).catch(() => undefined); }, []);
  const recs = Object.values(library).filter(r => inNiche(r, niche));
  if (!recs.length) return null;
  const ins = nicheInsights(recs);
  const run = async () => {
    setBusy(true);
    try {
      const samples = recs.filter(r => r.vision).sort((a, b) => b.views - a.views).map(r => ({ title: r.title, views: r.views, ratio: r.ratio, v: r.vision! }));
      if (samples.length < 3) throw new Error('Il faut au moins 3 miniatures analysées par Claude Vision dans cette niche.');
      const res = await synthesizeNiche(niche, ins, samples, await thumbnailPrinciples(`miniature ${niche}`, 8));
      useThumbs.setState(s => ({ syntheses: { ...s.syntheses, [niche]: res } }));
      await saveSyntheses(useThumbs.getState().syntheses);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return <Card title={<span>Ce que font les gros YouTubeurs — <span className="th-muted">{niche}</span></span>} actions={<Button size="sm" loading={busy} onClick={run}>{synth ? 'Refaire la synthèse Claude' : 'Synthèse Claude'}</Button>}>
    <div className="th-kpis">
      <div className="th-kpi"><div className="th-k">Miniatures</div><div className="th-kv">{ins.count}</div></div>
      <div className="th-kpi"><div className="th-k">Avec visage</div><div className="th-kv">{pct(ins.faceShare)}</div></div>
      <div className="th-kpi"><div className="th-k">Avec texte</div><div className="th-kv">{pct(ins.textShare)}</div></div>
      <div className="th-kpi"><div className="th-k">Mots (si texte)</div><div className="th-kv">{fr1(ins.avgWords)}</div></div>
      <div className="th-kpi"><div className="th-k">Éléments</div><div className="th-kv">{fr1(ins.avgElements)}</div></div>
      <div className="th-kpi"><div className="th-k">Lisibilité médiane</div><div className="th-kv">{fr1(ins.medianLegibility)}<span className="th-small th-muted">/10</span></div></div>
      <div className="th-kpi"><div className="th-k">Vues médianes</div><div className="th-kv">{formatNum(ins.medianViews)}</div></div>
      <div className="th-kpi"><div className="th-k">Vues/abonnés méd.</div><div className="th-kv">{ratioLabel(ins.medianRatio)}</div></div>
    </div>
    <div className="th-split" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', marginTop: 12 }}>
      <div><div className="th-section-title" style={{ marginTop: 0 }}>Émotions (visages)</div><Dist items={ins.emotions} /></div>
      <div><div className="th-section-title" style={{ marginTop: 0 }}>Couleur dominante</div><Dist items={ins.families} color={k => FAMILY_SWATCH[k as ColorFamily] ?? '#888'} /></div>
      <div><div className="th-section-title" style={{ marginTop: 0 }}>Composition</div><Dist items={ins.layouts} /></div>
    </div>
    {ins.lifts.length > 0 && <>
      <div className="th-section-title">Ce qui surperforme ({ins.lifts[0].metric === 'ratio' ? 'vues/abonnés médian' : 'vues médianes'})</div>
      <table className="th-table"><thead><tr><th>Caractéristique</th><th>Avec</th><th>Sans</th><th>Écart</th></tr></thead><tbody>
        {ins.lifts.map(l => { const d = l.withoutMedian ? l.withMedian / l.withoutMedian : 0; const fmt = (x: number) => (l.metric === 'ratio' ? ratioLabel(x) : formatNum(x));
          return <tr key={l.feature}><td>{l.feature}</td><td>{fmt(l.withMedian)} <span className="th-muted th-tiny">({l.withCount})</span></td><td>{fmt(l.withoutMedian)} <span className="th-muted th-tiny">({l.withoutCount})</span></td><td className={d >= 1.15 ? 'th-good' : d <= 0.87 ? 'th-bad' : 'th-muted'}>{d ? `×${fr1(d)}` : '–'}</td></tr>; })}
      </tbody></table>
      <div className="th-tiny th-muted" style={{ marginTop: 4 }}>Corrélations sur un petit échantillon : des indices, pas des preuves.</div>
    </>}
    {synth && <>
      <div className="th-section-title">Règles de la niche (Claude)</div>
      {synth.summary && <p style={{ marginTop: 0 }}>{synth.summary}</p>}
      <div className="th-feedback">{synth.rules.map((r, i) => <div key={i} className="th-fb bon"><span className="th-ic">{i + 1}</span><div><div className="th-strong">{r.rule}</div>{r.evidence && <div className="th-small th-muted">{r.evidence}</div>}<Citations list={r.citations} /></div></div>)}</div>
      {synth.opportunities.length > 0 && <><div className="th-section-title">Pour se démarquer</div><ul style={{ margin: 0, paddingLeft: 18 }}>{synth.opportunities.map((o, i) => <li key={i}>{o}</li>)}</ul></>}
    </>}
  </Card>;
}
