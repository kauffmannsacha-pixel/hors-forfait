// Outils texte purs (testés) : normalisation, tokenisation FR/EN, racinisation légère,
// expansion bilingue de requête, empreinte, similarité lexicale, classement par sujet.
import type { Topic } from './api';

export const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Minuscules, sans accents, ponctuation → espaces. */
export const normalize = (s: string) =>
  stripAccents(s.toLowerCase()).replace(/[’'`´]/g, ' ').replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim();

const STOPWORDS = new Set((
  // français
  'le la les l un une des de du d et ou a au aux en dans pour par sur sous avec sans que qui quoi ce cet cette ces c ' +
  'son sa ses leur leurs mon ma mes ton ta tes notre nos votre vos il elle ils elles on nous vous je j tu me m te t se s ' +
  'ne n pas plus moins est sont etre etait ete avoir avait ont ai as fait faire comme mais donc car si y qu tout tous toute ' +
  'toutes tres aussi bien alors quand dont entre chaque meme ici la cela ca celui celle ceux lui eux sera seront peut peuvent ' +
  'doit doivent avant apres encore deja toujours jamais rien autre autres quel quelle quels quelles fois sans ' +
  // anglais
  'the an and or of to in on for with without is are be been being was were it its this that these those you your yours we ' +
  'our they their them i my me he she his her at by from as so if then than but not no do does did doing have has had will ' +
  'would can could should just how what why when where who whom which about into more most very really also there here up ' +
  'out over only own same some such too any each other again further once all both few nor off'
).split(/\s+/));

export const isStopword = (w: string) => STOPWORDS.has(w);

/** Racinisation légère FR/EN : pluriels et quelques terminaisons fréquentes. */
export function stem(w: string): string {
  if (w.length <= 3 || /^\d+%?$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('aux') && w.length > 5) return w.slice(0, -3) + 'al';
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  if (w.endsWith('x') && w.length > 4) return w.slice(0, -1);
  return w;
}

/** Jetons normalisés, sans mots vides, racinisés. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of normalize(s).split(' ')) {
    if (!raw || isStopword(raw)) continue;
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Synonymes bilingues (formes racinisées) pour la recherche par mots-clés. */
const SYNONYMS: string[][] = [
  ['miniature', 'thumbnail', 'vignette'],
  ['titre', 'title'],
  ['accroche', 'hook', 'intro', 'introduction'],
  ['retention', 'decrochage', 'watchtime', 'attention'],
  ['boucle', 'loop'],
  ['curiosite', 'curiosity', 'curieux', 'curious'],
  ['script', 'scenario', 'ecriture', 'writing', 'scripting', 'ecrire', 'write'],
  ['histoire', 'story', 'storytelling', 'recit'],
  ['clic', 'click', 'ctr', 'clickbait'],
  ['vue', 'view'],
  ['idee', 'idea', 'concept'],
  ['payoff', 'recompense', 'climax', 'apogee'],
  ['rythme', 'pacing', 'tempo'],
  ['emballage', 'packaging'],
  ['algorithme', 'algorithm'],
  ['abonne', 'subscriber'],
  ['montage', 'editing', 'edit'],
  ['promesse', 'promise'],
  ['enjeu', 'stake'],
  ['escalade', 'escalation'],
  ['visage', 'face'],
  ['couleur', 'color', 'colour'],
  ['contraste', 'contrast'],
  ['chaine', 'channel'],
  ['spectateur', 'viewer', 'audience', 'public'],
  ['debut', 'beginning', 'start', 'opening'],
  ['fin', 'ending', 'end', 'outro'],
  ['sponsor', 'sponsoring', 'placement'],
];
const SYN_INDEX = new Map<string, string[]>();
for (const group of SYNONYMS) for (const w of group) SYN_INDEX.set(w, group.filter(x => x !== w));

/** Jetons de requête + synonymes (poids 0,5). */
export function expandQuery(query: string): { term: string; weight: number }[] {
  const base = tokenize(query);
  const seen = new Set<string>();
  const out: { term: string; weight: number }[] = [];
  for (const t of base) if (!seen.has(t)) { seen.add(t); out.push({ term: t, weight: 1 }); }
  for (const t of base) for (const s of SYN_INDEX.get(t) ?? []) if (!seen.has(s)) { seen.add(s); out.push({ term: s, weight: 0.5 }); }
  return out;
}

/** Empreinte FNV-1a 32 bits (hex). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export const principleHash = (title: string, text: string) => fnv1a(normalize(title) + '|' + normalize(text));

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
export const tokenSet = (s: string) => new Set(tokenize(s));

/** Mots-clés par sujet (formes racinisées, préfixes acceptés). */
const TOPIC_KEYWORDS: Record<Exclude<Topic, 'general'>, string[]> = {
  hook: ['hook', 'accroche', 'intro', 'introduction', 'cold', 'premiere', 'first', 'second', 'seconde', 'ouverture', 'opening'],
  thumbnail: ['miniature', 'thumbnail', 'vignette', 'visage', 'face', 'contraste', 'contrast', 'couleur', 'color', 'image', 'visuel'],
  title: ['titre', 'title', 'mot', 'word', 'caractere', 'character', 'headline'],
  retention: ['retention', 'boucle', 'loop', 'rehook', 're', 'rythme', 'pacing', 'decroch', 'drop', 'curiosite', 'curiosity', 'watchtime', 'temps', 'mort'],
  packaging: ['packaging', 'clic', 'click', 'ctr', 'clickbait', 'emballage', 'idee', 'idea', 'concept'],
  script: ['script', 'ecri', 'writ', 'histoire', 'story', 'storytelling', 'payoff', 'structure', 'plan', 'escalade', 'setup', 'recit'],
  analytics: ['analytics', 'statistique', 'stat', 'donnee', 'data', 'algorithme', 'algorithm', 'impression', 'courbe', 'graph', 'metric'],
};

/** Sujet le plus probable d'un texte (repli « general »). */
export function classifyTopic(text: string): Topic {
  const toks = tokenize(text);
  let best: Topic = 'general'; let bestScore = 0;
  for (const [topic, kws] of Object.entries(TOPIC_KEYWORDS) as [Topic, string[]][]) {
    let sc = 0;
    for (const t of toks) for (const k of kws) if (t === k || (k.length >= 4 && t.startsWith(k))) { sc++; break; }
    if (sc > bestScore) { best = topic; bestScore = sc; }
  }
  return best;
}

/** Mots-clés indiquant qu'une vidéo parle de création YouTube (filtre de pertinence). */
const RELEVANCE_KEYWORDS = [
  'youtube', 'youtuber', 'creator', 'createur', 'view', 'vue', 'viral', 'algorithm', 'algorithme', 'thumbnail', 'miniature',
  'title', 'titre', 'hook', 'retention', 'script', 'scripting', 'storytelling', 'story', 'packaging', 'clickbait', 'ctr',
  'subscriber', 'abonne', 'channel', 'chaine', 'grow', 'growth', 'croissance', 'editing', 'montage', 'idea', 'idee', 'intro',
  'audience', 'strategy', 'strategie', 'masterclass', 'tip', 'conseil', 'lesson', 'lecon', 'mistake', 'erreur', 'analytics',
  'mrbeast', 'genius', 'secret', 'rule', 'regle', 'formula', 'formule',
];
/** Score de pertinence d'une vidéo pour la base (titre ×2, description ×1). */
export function relevanceScore(title: string, description = ''): number {
  const t = new Set(tokenize(title)); const d = new Set(tokenize(description.slice(0, 600)));
  let sc = 0;
  for (const k of RELEVANCE_KEYWORDS) { if (t.has(k)) sc += 2; else if (d.has(k)) sc += 1; }
  return sc;
}

/** Coupe proprement à n caractères. */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1); const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, '') + '…';
}
