// Analyse locale de titres YouTube (aucun appel réseau) : longueur, chiffres, mots puissants,
// curiosité, émotions, structure → patterns, statistiques de niche, troncature mobile/desktop, score local.

export type Lang = 'fr' | 'en';
/** Caractères visibles avant troncature (fil mobile ≈ 50, accueil desktop ≈ 70, recherche desktop ≈ 100). */
export const MOBILE_VISIBLE = 50;
export const DESKTOP_VISIBLE = 70;
export const SEARCH_VISIBLE = 100;
export const YT_MAX_TITLE = 100;

/** Longueur en caractères visibles (les emojis comptent pour 1). */
export const titleLength = (t: string) => [...t.trim()].length;

/** Aperçu de troncature : YouTube coupe en fin de ligne, donc à un espace, puis ajoute « … ». */
export function truncateTitle(title: string, max: number): { visible: string; hidden: string; truncated: boolean } {
  const chars = [...title.trim().replace(/\s+/g, ' ')];
  if (chars.length <= max) return { visible: chars.join(''), hidden: '', truncated: false };
  let cut = chars.lastIndexOf(' ', max - 1);
  if (cut < max * 0.6) cut = max - 1;
  return { visible: chars.slice(0, cut).join('').trimEnd() + '…', hidden: chars.slice(cut).join('').trim(), truncated: true };
}

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'");
const tokens = (s: string): string[] => strip(s).match(/[a-z0-9%$€]+(?:'[a-z]+)?/g) ?? [];

export const POWER_WORDS: Record<Lang, string[]> = {
  fr: ['secret', 'secrets', 'secrete', 'interdit', 'interdite', 'illegal', 'illegale', 'impossible', 'incroyable', 'jamais', 'personne', 'ultime', 'meilleur', 'meilleure',
    'pire', 'vrai', 'vraie', 'verite', 'fou', 'folle', 'dingue', 'choquant', 'choc', 'gratuit', 'gratuitement', 'enfin', 'dangereux', 'danger', 'piege', 'arnaque',
    'cache', 'cachee', 'extreme', 'geant', 'geante', 'record', 'premier', 'premiere', 'dernier', 'derniere', 'seul', 'seule', 'nouveau', 'defi', 'survivre',
    'survecu', 'gagner', 'gagne', 'perdu', 'million', 'millions', 'riche', 'pauvre', 'hack', 'hacke', 'troll', 'prank', 'pirate', 'banni', 'invisible',
    'infini', 'mystere', 'detruit', 'terrifiant', 'horreur', 'cauchemar', 'fake', 'faux', 'trahi', 'vole', 'espion', 'urgent', 'enorme', 'legendaire',
    'rare', 'introuvable', 'oublie', 'sauve', 'police', 'prison', 'hante', 'maudit', 'milliardaire', 'gratuite'],
  en: ['secret', 'secrets', 'banned', 'illegal', 'impossible', 'insane', 'unbelievable', 'never', 'nobody', 'ultimate', 'best', 'worst', 'real', 'truth',
    'crazy', 'shocking', 'free', 'finally', 'dangerous', 'trap', 'scam', 'hidden', 'extreme', 'giant', 'record', 'first', 'last', 'only', 'new',
    'challenge', 'survive', 'survived', 'win', 'won', 'lost', 'million', 'millions', 'rich', 'poor', 'hacked', 'troll', 'prank', 'pranked', 'invisible',
    'infinite', 'mystery', 'destroyed', 'terrifying', 'horror', 'nightmare', 'fake', 'betrayed', 'stole', 'spy', 'every', 'legendary', 'rare',
    'forgotten', 'saved', 'police', 'jail', 'haunted', 'cursed', 'billionaire', 'expensive', 'cheapest'],
};

export type Emotion = 'peur' | 'colere' | 'joie' | 'surprise' | 'tristesse' | 'defi';
export const EMOTION_LABELS: Record<Emotion, string> = { peur: 'Peur', colere: 'Colère', joie: 'Émerveillement', surprise: 'Surprise', tristesse: 'Tristesse', defi: 'Défi' };
const EMOTIONS: Record<Emotion, string[]> = {
  peur: ['peur', 'terrifiant', 'terrifie', 'horreur', 'cauchemar', 'flippant', 'effrayant', 'danger', 'dangereux', 'mort', 'hante', 'maudit', 'scary', 'terrifying', 'horror', 'nightmare', 'haunted', 'creepy', 'dead', 'deadly', 'cursed'],
  colere: ['enerve', 'rage', 'scandale', 'arnaque', 'vole', 'trahi', 'injuste', 'honte', 'angry', 'scam', 'stole', 'betrayed', 'furious', 'exposed'],
  joie: ['incroyable', 'magnifique', 'reve', 'genial', 'parfait', 'heureux', 'epique', 'amazing', 'beautiful', 'dream', 'perfect', 'happy', 'epic'],
  surprise: ['choc', 'choquant', 'inattendu', 'surprise', 'fou', 'dingue', 'wtf', 'shocking', 'unexpected', 'insane', 'crazy', 'unbelievable'],
  tristesse: ['triste', 'pleure', 'pleurer', 'adieu', 'sad', 'cried', 'cry', 'goodbye', 'quit', 'arrete'],
  defi: ['defi', 'challenge', 'survivre', 'survecu', 'survive', 'survived', 'vs', 'contre'],
};

export type TitlePattern = 'experience' | 'defi-duree' | 'liste' | 'argent' | 'versus' | 'superlatif' | 'interdit-secret' | 'transformation'
  | 'si-alors' | 'comment-pourquoi' | 'question' | 'citation' | 'parenthese' | 'premiere-personne' | 'simple';
export const PATTERN_INFO: Record<TitlePattern, { label: string; template: string }> = {
  experience: { label: 'Expérience vécue', template: "J'ai [action extrême] (et [conséquence])" },
  'defi-duree': { label: 'Défi chronométré', template: "J'ai [survécu / passé] [N jours/heures] dans [lieu]" },
  liste: { label: 'Liste chiffrée', template: '[N] [choses] que [curiosité]' },
  argent: { label: 'Enjeu d\'argent', template: '[Montant] pour [action]' },
  versus: { label: 'Duel / versus', template: '[A] vs [B]' },
  superlatif: { label: 'Superlatif', template: 'Le/la plus [adjectif] [chose] du monde' },
  'interdit-secret': { label: 'Interdit / secret', template: 'Le secret / ce que personne ne [verbe]' },
  transformation: { label: 'Transformation', template: 'De [état A] à [état B]' },
  'si-alors': { label: 'Hypothèse', template: 'Si [condition], [conséquence]' },
  'comment-pourquoi': { label: 'Comment / pourquoi', template: 'Comment [résultat surprenant]' },
  question: { label: 'Question', template: '[Question intrigante] ?' },
  citation: { label: 'Citation / dialogue', template: '« [réplique choc] »' },
  parenthese: { label: 'Parenthèse teaser', template: '[Titre] ([conséquence inattendue])' },
  'premiere-personne': { label: 'Je / on', template: 'Je [action] [objet]' },
  simple: { label: 'Descriptif', template: '[Sujet] [complément]' },
};
const PATTERN_TESTS: [TitlePattern, RegExp][] = [
  ['experience', /^(?:j'ai|j’ai|on a|nous avons|i|we)\s+(?:test|essay|achet|construit|pass|surv[eé]cu|pi[eé]g|hack|pirat|vol|infiltr|cr[eé][eé]|tried|tested|bought|built|spent|survived|pranked|hacked|stole|created|made|became|devenu|trouv|found)/i],
  ['defi-duree', /(?:\d+|cent|mille|une?|24)\s*(?:jours?|heures?|h\b|ans?|semaines?|mois|minutes?|days?|hours?|years?|weeks?|months?)/i],
  ['liste', /^(?:top\s*)?\d+\s|^(?:les|the)\s+\d+\s/i],
  ['argent', /\d[\d\s.,]*\s?(?:€|\$|euros?|dollars?|robux|k\b|m\b|millions?)|\$\s?\d/i],
  ['versus', /(?:^|\s)(?:vs\.?|versus|contre)\s/i],
  ['superlatif', /\b(?:le|la|les)\s+plus\b|\b(?:meilleur|meilleure|pire|ultime|most|best|worst|biggest|smallest|richest|hardest|largest|ultimate|fastest|cheapest)\b/i],
  ['interdit-secret', /secret|interdit|ill[eé]gal|banni|cach[eé]|personne ne|jamais|never|nobody|banned|illegal|hidden|forbidden/i],
  ['transformation', /(?:^|\s)de\s+.+\s+(?:à|a)\s+.+|(?:^|\s)from\s+.+\s+to\s+.+/i],
  ['si-alors', /^(?:si|if)\s/i],
  ['comment-pourquoi', /^(?:comment|pourquoi|how|why|what)\b/i],
  ['question', /\?\s*$/],
  ['citation', /^[«"“]/],
  ['parenthese', /\(.+\)|\[.+\]/],
  ['premiere-personne', /^(?:j'|j’|je\s|moi\s|on\s|nous\s|i\s|i'm|i’m|i've|we\s|my\s)/i],
];

const CURIOSITY: [string, RegExp][] = [
  ['question', /\?/],
  ['suspension', /…|\.\.\./],
  ['pourquoi / comment', /\b(?:pourquoi|comment|why|how)\b/i],
  ['« ce que / ce qui »', /\bce qu(?:e|i)\b|\bwhat\b/i],
  ['personne ne…', /personne ne|nobody|no one/i],
  ['vérité / secret', /v[ée]rit[ée]|secret|truth/i],
  ['déictique (ça, ceci, this)', /(?:^|\s)(?:ça|ca|ceci|this|that)(?:\s|$|[!?.])/i],
  ['révélation', /\b(?:voici|j'ai trouv[ée]|j’ai trouv[ée]|here'?s|i found|revealed?|r[ée]v[ée]l)/i],
  ['parenthèse teaser', /\(.+\)/],
];
const ACRONYMS = new Set(['IA', 'AI', 'USA', 'GTA', 'PC', 'PS5', 'PS4', 'FBI', 'CIA', 'NASA', 'TV', 'YT', 'MR', 'RIP', 'FPS', 'RPG', 'IRL', 'VPN', 'DIY', 'UFO', 'OVNI', 'XXL', 'TOP', 'VS', 'UK', 'FR', 'EN', 'NBA', 'NFL', 'PSG', 'OM', 'F1']);

export interface TitleFeatures {
  title: string; length: number; words: number; hasNumber: boolean; numbers: string[]; bigNumber: boolean;
  powerWords: string[]; emotions: Emotion[]; curiosity: string[]; question: boolean; exclamation: boolean;
  firstPerson: boolean; capsWords: number; brackets: boolean; patterns: TitlePattern[]; pattern: TitlePattern; mobileTruncated: boolean;
}

export function analyzeTitle(title: string, lang: Lang = 'fr'): TitleFeatures {
  const t = title.trim();
  const toks = tokens(t);
  const numbers = t.match(/\d[\d\s.,]*\d|\d/g)?.map(n => n.trim()) ?? [];
  const bigNumber = numbers.some(n => Number(n.replace(/[\s.,]/g, '')) >= 100);
  const pw = new Set([...POWER_WORDS[lang], ...POWER_WORDS[lang === 'fr' ? 'en' : 'fr'].filter(w => ['fake', 'prank', 'troll', 'hack', 'record', 'challenge', 'vs'].includes(w))]);
  const powerWords = [...new Set(toks.filter(w => pw.has(w)))];
  if (lang === 'fr' && /personne ne/i.test(strip(t)) && !powerWords.includes('personne')) powerWords.push('personne');
  const emotions = (Object.keys(EMOTIONS) as Emotion[]).filter(e => EMOTIONS[e].some(w => toks.includes(w)));
  const curiosity = CURIOSITY.filter(([, re]) => re.test(t)).map(([label]) => label);
  const capsWords = (t.match(/[\p{Lu}]{3,}/gu) ?? []).filter(w => !ACRONYMS.has(w)).length
    + (t.match(/\b[\p{Lu}]{2}\b/gu) ?? []).filter(w => !ACRONYMS.has(w)).length;
  const patterns = PATTERN_TESTS.filter(([, re]) => re.test(t)).map(([p]) => p);
  return {
    title: t, length: titleLength(t), words: t.split(/\s+/).filter(Boolean).length, hasNumber: numbers.length > 0, numbers, bigNumber,
    powerWords, emotions, curiosity, question: /\?\s*$/.test(t) || /\?/.test(t), exclamation: /!/.test(t),
    firstPerson: /^(?:j'|j’|je\s|on\s|nous\s|moi\s|i\s|i'm|i’m|i've|we\s|my\s)/i.test(t) || /\b(?:j'ai|j’ai|mon|ma|mes)\b/i.test(t),
    capsWords, brackets: /\(.+\)|\[.+\]/.test(t), patterns, pattern: patterns[0] ?? 'simple', mobileTruncated: titleLength(t) > MOBILE_VISIBLE,
  };
}

// ── Statistiques d'une niche / chaîne ─────────────────────────
export interface TitleItem { title: string; views: number; id?: string; channel?: string; publishedAt?: string; thumbnail?: string }
export interface NicheStats {
  count: number; medianViews: number; avgLength: number; medianLength: number; avgWords: number;
  share: { number: number; question: number; firstPerson: number; power: number; caps: number; brackets: number; emotion: number; curiosity: number; mobileFit: number };
  lift: { number: number | null; question: number | null; firstPerson: number | null; power: number | null; brackets: number | null; curiosity: number | null; mobileFit: number | null };
  lengthBuckets: { label: string; min: number; max: number; count: number; medianViews: number }[];
  topPowerWords: { word: string; count: number; medianViews: number }[];
  emotions: { emotion: Emotion; count: number }[];
  patterns: { pattern: TitlePattern; count: number; share: number; medianViews: number; examples: TitleItem[] }[];
  top: TitleItem[];
}
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** Rapport des vues médianes avec / sans une caractéristique (null si un groupe a moins de 3 titres). */
export function liftOf(items: { views: number }[], has: boolean[]): number | null {
  const a = items.filter((_, i) => has[i]).map(x => x.views), b = items.filter((_, i) => !has[i]).map(x => x.views);
  if (a.length < 3 || b.length < 3) return null;
  const mb = median(b);
  return mb > 0 ? Math.round((median(a) / mb) * 100) / 100 : null;
}

export function nicheStats(items: TitleItem[], lang: Lang = 'fr'): NicheStats {
  const list = items.filter(i => i.title.trim());
  const f = list.map(i => analyzeTitle(i.title, lang));
  const n = list.length;
  const has = (k: (x: TitleFeatures) => boolean) => f.map(k);
  const count = (k: (x: TitleFeatures) => boolean) => f.filter(k).length;
  const lengths = f.map(x => x.length);
  const BUCKETS: [string, number, number][] = [['< 30', 0, 29], ['30-39', 30, 39], ['40-49', 40, 49], ['50-59', 50, 59], ['60-69', 60, 69], ['70 +', 70, 1000]];
  const pwMap = new Map<string, number[]>();
  f.forEach((x, i) => x.powerWords.forEach(w => pwMap.set(w, [...(pwMap.get(w) ?? []), list[i].views])));
  const pats = new Map<TitlePattern, number[]>();
  f.forEach((x, i) => pats.set(x.pattern, [...(pats.get(x.pattern) ?? []), i]));
  return {
    count: n, medianViews: median(list.map(i => i.views)),
    avgLength: n ? Math.round(lengths.reduce((a, b) => a + b, 0) / n) : 0, medianLength: Math.round(median(lengths)),
    avgWords: n ? Math.round((f.reduce((a, x) => a + x.words, 0) / n) * 10) / 10 : 0,
    share: {
      number: pct(count(x => x.hasNumber), n), question: pct(count(x => x.question), n), firstPerson: pct(count(x => x.firstPerson), n),
      power: pct(count(x => x.powerWords.length > 0), n), caps: pct(count(x => x.capsWords > 0), n), brackets: pct(count(x => x.brackets), n),
      emotion: pct(count(x => x.emotions.length > 0), n), curiosity: pct(count(x => x.curiosity.length > 0), n), mobileFit: pct(count(x => !x.mobileTruncated), n),
    },
    lift: {
      number: liftOf(list, has(x => x.hasNumber)), question: liftOf(list, has(x => x.question)), firstPerson: liftOf(list, has(x => x.firstPerson)),
      power: liftOf(list, has(x => x.powerWords.length > 0)), brackets: liftOf(list, has(x => x.brackets)), curiosity: liftOf(list, has(x => x.curiosity.length > 0)),
      mobileFit: liftOf(list, has(x => !x.mobileTruncated)),
    },
    lengthBuckets: BUCKETS.map(([label, min, max]) => {
      const v = list.filter((_, i) => lengths[i] >= min && lengths[i] <= max).map(x => x.views);
      return { label, min, max, count: v.length, medianViews: median(v) };
    }),
    topPowerWords: [...pwMap.entries()].map(([word, v]) => ({ word, count: v.length, medianViews: median(v) })).sort((a, b) => b.count - a.count || b.medianViews - a.medianViews).slice(0, 14),
    emotions: (Object.keys(EMOTIONS) as Emotion[]).map(e => ({ emotion: e, count: count(x => x.emotions.includes(e)) })).filter(e => e.count > 0).sort((a, b) => b.count - a.count),
    patterns: [...pats.entries()].map(([pattern, idx]) => ({
      pattern, count: idx.length, share: pct(idx.length, n), medianViews: median(idx.map(i => list[i].views)),
      examples: idx.map(i => list[i]).sort((a, b) => b.views - a.views).slice(0, 3),
    })).sort((a, b) => b.count - a.count),
    top: [...list].sort((a, b) => b.views - a.views).slice(0, 12),
  };
}

// ── Score local d'un titre ────────────────────────────────────
const round1 = (v: number) => Math.round(v * 10) / 10;
export function localTitleScore(title: string, ctx: { lang?: Lang; thumbnailText?: string; stats?: NicheStats } = {}): { score: number; reasons: string[]; features: TitleFeatures } {
  const f = analyzeTitle(title, ctx.lang ?? 'fr');
  const reasons: string[] = [];
  if (!f.title) return { score: 0, reasons: ['Titre vide.'], features: f };
  let s = 5;
  if (f.length <= MOBILE_VISIBLE) { s += 1.5; reasons.push(`${f.length} caractères : lisible en entier sur mobile.`); }
  else if (f.length <= 60) { s += 0.5; reasons.push(`${f.length} caractères : légère troncature sur mobile (« ${truncateTitle(f.title, MOBILE_VISIBLE).visible} »).`); }
  else if (f.length <= DESKTOP_VISIBLE) { s -= 0.5; reasons.push(`${f.length} caractères : tronqué sur mobile, garde l'essentiel dans les 50 premiers.`); }
  else { s -= 1.5; reasons.push(`${f.length} caractères : trop long, tronqué sur mobile et sur desktop.`); }
  if (f.length < 20) { s -= 1; reasons.push('Très court : peu de place pour la curiosité.'); }
  if (f.hasNumber) { s += 1; reasons.push(`Chiffre concret (${f.numbers.slice(0, 2).join(', ')}).`); }
  if (f.powerWords.length) { s += f.powerWords.length > 1 ? 1.5 : 1; reasons.push(`Mot${f.powerWords.length > 1 ? 's' : ''} puissant${f.powerWords.length > 1 ? 's' : ''} : ${f.powerWords.slice(0, 3).join(', ')}.`); }
  if (f.curiosity.length) { s += 1.5; reasons.push(`Curiosité : ${f.curiosity.slice(0, 2).join(', ')}.`); }
  else reasons.push('Pas de levier de curiosité clair (question, révélation, « ce que… »).');
  if (f.emotions.length) { s += 0.5; reasons.push(`Émotion : ${f.emotions.map(e => EMOTION_LABELS[e]).join(', ')}.`); }
  if (f.firstPerson) { s += 0.5; reasons.push('Récit à la 1re personne (créateur impliqué).'); }
  if (f.capsWords > 2) { s -= 1; reasons.push('Trop de mots en majuscules : effet « putaclic ».'); }
  if (/[!?]{2,}/.test(f.title)) { s -= 0.5; reasons.push('Ponctuation répétée (!! / ??) à éviter.'); }
  if (ctx.thumbnailText?.trim()) {
    const tw = tokens(ctx.thumbnailText).filter(w => w.length > 2);
    const titleToks = new Set(tokens(f.title));
    const overlap = tw.length ? tw.filter(w => titleToks.has(w)).length / tw.length : 0;
    if (overlap > 0.5) { s -= 1.5; reasons.push('Répète le texte de la miniature : ils doivent se compléter, pas se répéter.'); }
    else if (tw.length) { s += 0.5; reasons.push('Complète le texte de la miniature sans le répéter.'); }
  }
  if (ctx.stats) {
    if (f.hasNumber && (ctx.stats.lift.number ?? 0) > 1.3) { s += 0.5; reasons.push(`Dans cette niche, les titres chiffrés font ×${ctx.stats.lift.number} vues.`); }
    if (f.question && (ctx.stats.lift.question ?? 1) < 0.7) { s -= 0.5; reasons.push('Dans cette niche, les questions performent moins bien.'); }
  }
  return { score: round1(Math.min(10, Math.max(0, s))), reasons, features: f };
}

/** Recouvrement de mots entre titre et texte de miniature (0-1). */
export function textOverlap(a: string, b: string): number {
  const ta = tokens(a).filter(w => w.length > 2), tb = new Set(tokens(b).filter(w => w.length > 2));
  if (!ta.length || !tb.size) return 0;
  return ta.filter(w => tb.has(w)).length / Math.min(ta.length, tb.size);
}

/** Identifie l'entrée « chaîne » (URL, @handle, ID UC…) ou « mots-clés ». */
export function parseChannelInput(input: string): { kind: 'id'; id: string } | { kind: 'handle'; handle: string } | { kind: 'user'; name: string } | { kind: 'custom'; name: string } | { kind: 'keywords'; q: string } {
  const s = input.trim();
  const id = /(?:youtube\.com\/channel\/)?(UC[\w-]{22})\b/.exec(s);
  if (id) return { kind: 'id', id: id[1] };
  const handle = /(?:youtube\.com\/)?(@[\w.-]{3,30})/.exec(s);
  if (handle && (s.startsWith('@') || /youtube\.com/.test(s))) return { kind: 'handle', handle: handle[1] };
  const user = /youtube\.com\/user\/([\w.-]+)/.exec(s);
  if (user) return { kind: 'user', name: user[1] };
  const custom = /youtube\.com\/c\/([\w.-]+)/.exec(s);
  if (custom) return { kind: 'custom', name: custom[1] };
  return { kind: 'keywords', q: s };
}

/** Format compact des vues (12 k, 1,2 M). */
export function fmtViews(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',').replace(',0', '')} Md`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',').replace(',0', '')} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(Math.round(n));
}
