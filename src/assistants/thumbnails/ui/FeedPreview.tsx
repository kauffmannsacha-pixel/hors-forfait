// Fil vidéo SIMULÉ (rendu neutre façon plateforme vidéo, sans logo ni marque) : accueil desktop (grille),
// colonne de suggestions (168×94, taille réelle), mobile (liste) ; thème sombre/clair ; ma miniature parmi la niche.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from '../../../ui/kit';
import { inNiche, useThumbs } from '../state';
import { mulberry32 } from '../lib/kmeans';
import { formatAgo, formatDuration, formatViews } from '../lib/format';
import { ytThumbUrl } from '../lib/browserImage';
import { Check, Seg } from './common';

interface FeedItem { id: string; img: string; title: string; channel: string; meta: string; duration: string; mine?: boolean }
type Layout = 'accueil' | 'suggestions' | 'mobile';
const AVATAR = ['#5b6b7a', '#7a5b6b', '#5b7a68', '#7a6f5b', '#625b7a', '#4f6f80', '#806650'];
const avatarColor = (s: string) => AVATAR[[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length];

function Card({ it, layout, highlight, pulse }: { it: FeedItem; layout: Layout; highlight: boolean; pulse: boolean }) {
  const cls = `th-fcard${it.mine && highlight ? ' mine' : ''}${it.mine && pulse ? ' pulse' : ''}`;
  const thumb = <div className="th-fthumb"><img src={it.img} alt="" loading="lazy" draggable={false} /><span className="th-fdur">{it.duration}</span></div>;
  if (layout === 'suggestions') return <div className={`${cls} th-scard`}>{thumb}<div><div className="th-ftitle">{it.title}</div><div className="th-fmeta">{it.channel}<br />{it.meta}</div></div></div>;
  return <div className={cls}>{thumb}<div className="th-finfo">
    <div className="th-favatar" style={{ background: avatarColor(it.channel) }}>{(it.channel.trim()[0] ?? '?').toUpperCase()}</div>
    <div><div className="th-ftitle">{it.title}</div><div className="th-fmeta">{it.channel} · {it.meta}</div></div>
  </div></div>;
}

export function FeedPreview({ mineUrl, title, niche }: { mineUrl: string; title: string; niche: string }) {
  const library = useThumbs(s => s.library);
  const [layout, setLayout] = useState<Layout>('accueil');
  const [theme, setTheme] = useState<'sombre' | 'clair'>('sombre');
  const [position, setPosition] = useState<'aleatoire' | 'premier' | 'milieu'>('aleatoire');
  const [seed, setSeed] = useState(1);
  const [duration, setDuration] = useState('12:34');
  const [channel, setChannel] = useState('Ma chaîne');
  const [tw, setTw] = useState(300);
  const [highlight, setHighlight] = useState(true);
  const [phase, setPhase] = useState<'idle' | 'look' | 'reveal'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const competitors = useMemo(() => Object.values(library).filter(r => inNiche(r, niche)).sort((a, b) => b.views - a.views), [library, niche]);
  const items = useMemo(() => {
    const n = layout === 'accueil' ? 11 : layout === 'suggestions' ? 9 : 5;
    const pool = competitors.slice(0, Math.max(n, 16));
    const rnd = mulberry32(seed); const shuffled = [...pool].sort(() => rnd() - 0.5).slice(0, n);
    const list: FeedItem[] = shuffled.map(r => ({ id: r.videoId, img: r.imageUrl || ytThumbUrl(r.videoId), title: r.title, channel: r.channelTitle, meta: `${formatViews(r.views)} · ${formatAgo(r.publishedAt)}`, duration: formatDuration(r.durationSec) }));
    const mine: FeedItem = { id: 'mine', img: mineUrl, title: title || 'Titre de ma vidéo', channel: channel || 'Ma chaîne', meta: 'il y a 1 heure', duration: duration || '12:34', mine: true };
    const at = position === 'premier' ? 0 : position === 'milieu' ? Math.floor(list.length / 2) : Math.floor(rnd() * (list.length + 1));
    list.splice(at, 0, mine);
    return list;
  }, [competitors, layout, seed, position, mineUrl, title, channel, duration]);

  const test3s = () => {
    clearTimeout(timer.current);
    setSeed(s => s + 1); setPosition('aleatoire'); setPhase('look');
    timer.current = setTimeout(() => setPhase('reveal'), 3000);
  };
  const showHighlight = phase === 'look' ? false : phase === 'reveal' ? true : highlight;
  const feedCls = `th-feed${theme === 'clair' ? ' light' : ''}`;

  return <div className="th-col">
    <div className="th-row">
      <Seg value={layout} onChange={setLayout} label="Disposition" options={[{ id: 'accueil', label: 'Accueil (desktop)' }, { id: 'suggestions', label: 'Suggestions 168×94' }, { id: 'mobile', label: 'Mobile' }]} />
      <Seg value={theme} onChange={setTheme} label="Thème" options={[{ id: 'sombre', label: 'Sombre' }, { id: 'clair', label: 'Clair' }]} />
      <Seg value={position} onChange={setPosition} label="Position" options={[{ id: 'aleatoire', label: 'Aléatoire' }, { id: 'premier', label: 'En premier' }, { id: 'milieu', label: 'Au milieu' }]} />
      <Button size="sm" onClick={() => setSeed(s => s + 1)}>Mélanger</Button>
      <Button size="sm" variant="primary" onClick={test3s}>Test des 3 secondes</Button>
    </div>
    <div className="th-row">
      <Input value={channel} onChange={e => setChannel(e.target.value)} placeholder="Nom de chaîne" style={{ width: 180 }} aria-label="Nom de chaîne" />
      <Input value={duration} onChange={e => setDuration(e.target.value)} placeholder="Durée" style={{ width: 90 }} aria-label="Durée" />
      {layout === 'accueil' && <Seg value={String(tw)} onChange={v => setTw(Number(v))} label="Taille" options={[{ id: '260', label: 'Portable' }, { id: '300', label: 'Écran moyen' }, { id: '360', label: 'Grand écran' }]} />}
      <Check checked={highlight} onChange={setHighlight} label="Repérer ma miniature" />
    </div>
    {phase === 'look' && <div className="th-note">⏱ Regarde le fil 3 secondes : ta miniature attire-t-elle l'œil en premier ?</div>}
    {phase === 'reveal' && <div className="th-note">La voici, entourée. L'avais-tu repérée tout de suite ? Sinon : plus de contraste, un sujet plus gros, moins d'éléments.</div>}
    {!competitors.length && <div className="th-note">Aucun concurrent pour cette niche : analyse-la d'abord (onglet Analyse) pour te comparer aux miniatures qui cartonnent.</div>}
    {layout === 'mobile'
      ? <div className={`${feedCls} th-phone`} style={{ padding: '10px 0 18px' }}>
        <div className="th-phone-bar"><span>9:41</span><span>●●● ▮</span></div>
        <div className="th-feed-chips" style={{ padding: '0 12px' }}><span>Tout</span><span>{niche || 'Pour toi'}</span><span>Récemment ajoutées</span></div>
        {items.map(it => <Card key={it.id} it={it} layout="mobile" highlight={showHighlight} pulse={phase === 'reveal'} />)}
      </div>
      : <div className={feedCls}>
        <div className="th-feed-top"><span className="th-feed-logo"><i />Vidéos</span><div className="th-feed-search">Rechercher</div></div>
        {layout === 'accueil'
          ? <><div className="th-feed-chips"><span>Tout</span><span>{niche || 'Pour toi'}</span><span>Jeux vidéo</span><span>En direct</span><span>Récemment ajoutées</span></div>
            <div className="th-feed-grid" style={{ ['--tw' as string]: `${tw}px` }}>{items.map(it => <Card key={it.id} it={it} layout="accueil" highlight={showHighlight} pulse={phase === 'reveal'} />)}</div></>
          : <div className="th-row" style={{ alignItems: 'flex-start', gap: 24 }}>
            <div style={{ flex: 1, minWidth: 260 }}><div className="th-fthumb" style={{ aspectRatio: '16/9', borderRadius: 12, background: 'var(--fchip)' }} /><div className="th-ftitle" style={{ marginTop: 10, opacity: 0.5 }}>Vidéo en cours de lecture</div></div>
            <div className="th-feed-side">{items.map(it => <Card key={it.id} it={it} layout="suggestions" highlight={showHighlight} pulse={phase === 'reveal'} />)}</div>
          </div>}
      </div>}
  </div>;
}
