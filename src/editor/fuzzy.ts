// Recherche floue partagée (menu « / », mentions, palette Ctrl+K, emojis).

/** Minuscules + suppression des accents (« Équation » → « equation »). */
export const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const isWordStart = (t: string, i: number) => i === 0 || /[\s\-_/.(«"'’]/.test(t[i - 1]);

/**
 * Score flou (plus haut = meilleur), `null` si la requête ne correspond pas.
 * Sous-chaîne exacte > préfixe de mot > sous-séquence (bonus consécutifs / débuts de mots).
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalize(query).trim();
  if (!q) return 0;
  const t = normalize(text);
  if (!t) return null;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    let s = 1000 - idx * 2 - Math.max(0, t.length - q.length) * 0.4;
    if (idx === 0) s += 300;
    else if (isWordStart(t, idx)) s += 150;
    return s;
  }
  // Tous les mots présents (dans n'importe quel ordre)
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(w => t.includes(w))) return 600 - t.length * 0.4;
  // Sous-séquence
  let score = 0; let ti = 0; let prev = -2; let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (found === prev + 1) { streak++; score += 8 + streak * 4; } else { streak = 0; score += 1; }
    if (isWordStart(t, found)) score += 7;
    score -= Math.min(found - ti, 12) * 0.6;
    prev = found; ti = found + 1;
  }
  // Une sous-séquence trop éparpillée n'est pas pertinente
  return score > q.length * 2 ? score : null;
}

/** Meilleur score sur plusieurs champs pondérés. */
export function fuzzyBest(query: string, fields: [string | undefined | null, number][]): number | null {
  let best: number | null = null;
  for (const [text, weight] of fields) {
    if (!text) continue;
    const s = fuzzyScore(query, text);
    if (s !== null && (best === null || s * weight > best)) best = s * weight;
  }
  return best;
}

/** Filtre + trie une liste par pertinence. */
export function fuzzyFilter<T>(items: T[], query: string, fields: (item: T) => [string | undefined | null, number][], limit = Infinity): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { item: T; s: number; i: number }[] = [];
  items.forEach((item, i) => { const s = fuzzyBest(query, fields(item)); if (s !== null) scored.push({ item, s, i }); });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map(x => x.item);
}

/** Mots (normalisés) d'une requête. */
export const queryWords = (q: string) => normalize(q).split(/[\s,;:.!?'"«»()]+/).filter(w => w.length > 0);

/** Tous les mots de la requête apparaissent dans le texte (déjà normalisé). */
export function containsAllWords(normText: string, words: string[]): boolean {
  return words.length > 0 && words.every(w => normText.includes(w));
}

/** Extrait de `text` autour de la première occurrence d'un des mots. */
export function snippetAround(text: string, words: string[], radius = 70): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const n = normalize(flat);
  let at = -1;
  for (const w of words) { const i = n.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? '…' : '');
  const start = Math.max(0, at - radius); const end = Math.min(flat.length, at + radius);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}
