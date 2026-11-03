import { useMemo, useState } from 'react';
import { EMOJIS, EMOJI_CATEGORIES, pushRecentEmoji, recentEmojis, searchEmojis } from '../emoji';
import { COLORS } from '../colors';

export interface EmojiResult { emoji?: string | null; color?: string }

export function EmojiPicker({ onPick, colors, color, allowRemove }: { onPick: (r: EmojiResult) => void; colors?: boolean; color?: string; allowRemove?: boolean }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const recents = useMemo(recentEmojis, []);
  const list = useMemo(() => q.trim() ? searchEmojis(q, 160) : EMOJIS.filter(e => !cat || e.cat === cat), [q, cat]);
  const pick = (e: string) => { pushRecentEmoji(e); onPick({ emoji: e }); };
  return (
    <div className="emoji-picker">
      <div className="emoji-top">
        <input className="input emoji-search" autoFocus placeholder="Rechercher un emoji…" value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); pick(list[0].e); } }} />
        <button type="button" className="btn btn-ghost btn-sm" title="Emoji aléatoire"
          onClick={() => pick(EMOJIS[Math.floor(Math.random() * EMOJIS.length)].e)}>🎲</button>
        {allowRemove && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPick({ emoji: null })}>Retirer</button>}
      </div>
      {colors && (
        <div className="emoji-colors" role="radiogroup" aria-label="Couleur">
          {COLORS.map(c => (
            <button key={c.id} type="button" role="radio" aria-checked={color === c.id} title={c.label}
              className={`swatch${color === c.id ? ' on' : ''}`} style={{ background: c.id === 'default' ? 'var(--line)' : c.bg ?? undefined, borderColor: c.swatch }}
              onClick={() => onPick({ color: c.id })} />
          ))}
        </div>
      )}
      {!q && (
        <div className="emoji-cats" role="tablist">
          <button type="button" role="tab" aria-selected={cat === null} className={cat === null ? 'on' : ''} onClick={() => setCat(null)} title="Tous">✳️</button>
          {EMOJI_CATEGORIES.map(c => (
            <button key={c.id} type="button" role="tab" aria-selected={cat === c.id} className={cat === c.id ? 'on' : ''} title={c.label} onClick={() => setCat(c.id)}>{c.icon}</button>
          ))}
        </div>
      )}
      <div className="emoji-scroll">
        {!q && !cat && recents.length > 0 && <>
          <div className="emoji-sec">Récents</div>
          <div className="emoji-grid">{recents.map(e => <button key={'r' + e} type="button" onClick={() => pick(e)}>{e}</button>)}</div>
        </>}
        {!q && <div className="emoji-sec">{cat ? EMOJI_CATEGORIES.find(c => c.id === cat)?.label : 'Tous les emojis'}</div>}
        <div className="emoji-grid">
          {list.map(x => <button key={x.e + x.k} type="button" title={x.k} onClick={() => pick(x.e)}>{x.e}</button>)}
        </div>
        {list.length === 0 && <div className="muted emoji-empty">Aucun emoji trouvé.</div>}
      </div>
    </div>
  );
}
