// Appels Claude (Vision + JSON) du miniatureur. Chaque conseil s'appuie sur les principes sourcés.
import type Anthropic from '@anthropic-ai/sdk';
import { askClaudeJSON } from '../../../claude/api';
import { principlesToPrompt, searchPrinciples, type Principle } from '../../../knowledge/api';
import type { VisionImage } from './browserImage';
import type { ImageMetrics } from './metrics';
import { fmtRatio } from './metrics';
import { extractCitations, normalizeConcept, normalizeCritique, normalizeVision } from './normalize';
import { EMOTIONS, LAYOUTS, type Brief, type Concept, type MyCritique, type VisionAnalysis } from './types';
import type { NicheInsights } from './insights';
import { formatNum } from './format';

/** Principes « miniature » de la base de connaissances (vide si la base n'est pas prête). */
export async function thumbnailPrinciples(query: string, k = 8): Promise<Principle[]> {
  try { return await searchPrinciples(query, { topic: 'thumbnail', k }); } catch { return []; }
}
const principlesBlock = (ps: Principle[]) => ps.length
  ? `\n\nPrincipes sourcés de la base de connaissances (cite-les par leur numéro [n] quand ils justifient un point ; n'invente jamais de source) :\n${principlesToPrompt(ps)}`
  : '\n\n(Aucun principe sourcé disponible : ne cite aucune source.)';

const EXPERT = `Tu es un directeur artistique expert du packaging YouTube (miniatures), formé aux méthodes publiques de MrBeast, Paddy Galloway, Film Booth et Creator Booth. Tu réponds en français.`;
const imageBlock = (img: VisionImage): Anthropic.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
const textBlock = (text: string): Anthropic.TextBlockParam => ({ type: 'text', text });

// ── 1. Miniatures des concurrents ───────────────────────────────────────────
export interface CompetitorInput { image: VisionImage; title: string; channel: string; views: number; ratio?: number }
const VISION_SCHEMA = `{"index": numéro, "face": booléen, "faceCount": entier, "emotion": "${EMOTIONS.join('|')}", "emotionIntensity": 0-10, "elements": ["éléments visuels principaux, 1 à 6"], "elementCount": entier, "hasText": booléen, "text": "texte incrusté exact ('' si aucun)", "wordCount": entier, "focalPoint": {"x": 0-1, "y": 0-1, "description": "…"}, "composition": "1 phrase", "layout": "${LAYOUTS.join('|')}", "background": "…", "colorStrategy": "…", "curiosity": "la question que se pose le spectateur", "whyItWorks": ["2 à 4 raisons concrètes et spécifiques à CETTE image, avec [n] si un principe s'applique"], "weaknesses": ["0 à 2 points faibles"]}`;

export async function analyzeCompetitors(items: CompetitorInput[], principles: Principle[], opts: { signal?: AbortSignal; fast?: boolean } = {}): Promise<VisionAnalysis[]> {
  const content: Anthropic.ContentBlockParam[] = [];
  items.forEach((it, i) => {
    content.push(textBlock(`Miniature n°${i + 1} — titre de la vidéo : « ${it.title} » · chaîne : ${it.channel} · ${formatNum(it.views)} vues${it.ratio != null ? ` · ${it.ratio.toFixed(1).replace('.', ',')}× le nombre d'abonnés` : ''}`));
    content.push(imageBlock(it.image));
  });
  content.push(textBlock(`Analyse chacune des ${items.length} miniatures. Réponds par un tableau JSON de ${items.length} objets, dans l'ordre :\n${VISION_SCHEMA}\nRègles : « aucune » pour emotion s'il n'y a pas de visage ; le texte incrusté est uniquement le texte visible DANS l'image (jamais le titre) ; coordonnées normalisées, origine en haut à gauche ; sois factuel.`));
  const raw = await askClaudeJSON<unknown>({
    system: `${EXPERT}\nTu analyses des miniatures de vidéos très performantes : décris précisément ce que tu vois, sans extrapoler.${principlesBlock(principles)}`,
    messages: [{ role: 'user', content }], maxTokens: 900 * items.length + 600, fast: opts.fast, signal: opts.signal,
  });
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items) ? (raw as { items: unknown[] }).items : [raw]);
  return items.map((_, i) => {
    const byIndex = arr.find(a => a && typeof a === 'object' && Number((a as { index?: unknown }).index) === i + 1);
    return normalizeVision(byIndex ?? arr[i], principles);
  });
}

// ── 2. Critique de MA miniature ─────────────────────────────────────────────
export function metricsSummary(m: ImageMetrics): string {
  const pal = m.palette.map(p => `${p.hex} ${p.name} ${Math.round(p.share * 100)} %`).join(', ');
  return [
    `Format : ${m.width}×${m.height} (ratio ${m.aspect.toFixed(2)})`,
    `Lisibilité en 168×94 : ${m.legibility.score}/10 (sujet/fond ${fmtRatio(m.legibility.contrastRatio)}, ΔE ${Math.round(m.legibility.deltaE)})`,
    `Contraste global : écart-type L* ${Math.round(m.rmsContrast * 100)}, plage ${m.dynamicRange} ; luminosité moyenne L* ${Math.round(m.luminance.mean)}/100`,
    `Couleurs : colorfulness ${Math.round(m.colorfulness)}, saturation moyenne ${Math.round(m.saturation * 100)} % ; palette : ${pal}`,
    `Netteté (variance du laplacien) : ${Math.round(m.sharpness)}`,
    `Point focal mesuré : x=${m.focal.x.toFixed(2)}, y=${m.focal.y.toFixed(2)} (${m.thirds}), concentration ${Math.round(m.focal.concentration * 100)} %, ${m.focal.blobs} zone(s) saillante(s), contraste sujet/fond ${fmtRatio(m.focalContrast)}`,
    `Saillance dans le coin bas-droit (zone de la durée) : ${Math.round(m.cornerSaliency * 100)} %`,
    `Notes locales /10 : lisibilité ${m.scores.legibility}, contraste ${m.scores.contrast}, focus ${m.scores.focus}, couleur ${m.scores.color}, netteté ${m.scores.sharpness}`,
  ].join('\n');
}
export function insightsSummary(ins: NicheInsights): string {
  if (!ins.count) return '';
  const emo = ins.emotions.slice(0, 3).map(e => `${e.key} ${Math.round(e.share * 100)} %`).join(', ');
  const fam = ins.families.slice(0, 4).map(e => `${e.key} ${Math.round(e.share * 100)} %`).join(', ');
  return `Référence de la niche (${ins.count} miniatures parmi les plus vues) : visage ${Math.round(ins.faceShare * 100)} % ; texte ${Math.round(ins.textShare * 100)} % (${ins.avgWords.toFixed(1).replace('.', ',')} mots en moyenne) ; émotions : ${emo || 'n/d'} ; couleurs dominantes : ${fam || 'n/d'} ; lisibilité médiane ${ins.medianLegibility.toFixed(1).replace('.', ',')}/10 ; éléments moyens ${ins.avgElements.toFixed(1).replace('.', ',')}.`;
}

export async function critiqueMine(input: { image: VisionImage; small: VisionImage; metrics?: ImageMetrics; title?: string; niche?: string; insights?: NicheInsights }, principles: Principle[], opts: { signal?: AbortSignal } = {}): Promise<MyCritique> {
  const ctx = [
    input.title ? `Titre prévu : « ${input.title} »` : 'Titre prévu : non renseigné',
    input.niche ? `Niche : ${input.niche}` : '',
    input.metrics ? `Mesures locales (calculées sur les pixels) :\n${metricsSummary(input.metrics)}` : '',
    input.insights ? insightsSummary(input.insights) : '',
  ].filter(Boolean).join('\n\n');
  const content: Anthropic.ContentBlockParam[] = [
    textBlock('Image 1 : ma miniature (taille réelle).'), imageBlock(input.image),
    textBlock('Image 2 : la même miniature telle qu\'elle apparaît en 168×94 dans la colonne de suggestions (agrandie ×2).'), imageBlock(input.small),
    textBlock(`${ctx}\n\nCritique cette miniature comme un directeur artistique exigeant. Réponds avec cet objet JSON :\n{"score": 0-10 (une décimale), "verdict": "1 phrase", "face": booléen, "emotion": "${EMOTIONS.join('|')}", "text": "texte incrusté exact", "elementCount": entier, "focalPoint": {"x": 0-1, "y": 0-1, "description": "…"}, "strengths": ["…"], "problems": [{"issue": "problème précis et localisé (où, quoi)", "fix": "retouche concrète et actionnable (valeurs, couleurs, tailles)", "severity": "haute|moyenne|basse", "principles": [numéros des principes qui le justifient]}], "quickWins": ["3 retouches rapides, ordonnées par impact"], "titleSynergy": "la miniature complète-t-elle le titre sans le répéter ? (vide si pas de titre)", "smallSize": "comment elle se lit en 168×94"}\nBarème : 9-10 = au niveau des meilleures miniatures de la niche ; 6-7 = correcte mais générique ; < 5 = confuse ou illisible en petit. Appuie-toi sur les mesures fournies (elles sont exactes) et cite les principes [n] pertinents.`),
  ];
  const raw = await askClaudeJSON<unknown>({
    system: `${EXPERT}\nTu évalues la miniature d'un créateur pour maximiser son taux de clic, sans complaisance mais avec bienveillance.${principlesBlock(principles)}`,
    messages: [{ role: 'user', content }], maxTokens: 3000, signal: opts.signal,
  });
  return normalizeCritique(raw, principles);
}

// ── 3. Générateur de concepts ───────────────────────────────────────────────
export async function generateConcepts(brief: Brief, principles: Principle[], ctx: { insights?: NicheInsights; refs?: { image: VisionImage; label: string }[]; signal?: AbortSignal }): Promise<Concept[]> {
  const n = Math.min(5, Math.max(3, brief.count));
  const content: Anthropic.ContentBlockParam[] = [];
  (ctx.refs ?? []).forEach((r, i) => { content.push(textBlock(`Référence ${i + 1} (miniature gardée par le créateur) : ${r.label}`)); content.push(imageBlock(r.image)); });
  content.push(textBlock([
    `Brief :`, `- Sujet de la vidéo : ${brief.subject}`, `- Émotion visée : ${brief.emotion || 'à choisir'}`,
    `- Titre prévu : ${brief.title ? `« ${brief.title} »` : 'non défini'}`, brief.niche ? `- Niche : ${brief.niche}` : '',
    brief.constraints ? `- Contraintes : ${brief.constraints}` : '',
    ctx.insights ? insightsSummary(ctx.insights) : '',
    (ctx.refs ?? []).length ? 'Inspire-toi de l\'énergie des références sans les copier.' : '',
    '',
    `Propose ${n} concepts de composition VRAIMENT différents (cadrage, idée, palette). Réponds avec {"concepts": [${n} objets]} :`,
    `{"name": "nom court", "idea": "le concept en 1 phrase", "shot": "cadrage (gros plan visage, plan taille, split screen…)", "subject": "sujet principal", "expression": "expression du visage (ou '' sans visage)", "elements": ["1 à 3 éléments forts"], "colors": ["3 ou 4 couleurs hex"], "background": "fond", "text": "texte incrusté de 3 mots MAXIMUM, ou ''", "textColor": "#hex", "textStroke": "#hex", "textPosition": "haut-gauche|haut-droite|haut|centre|bas-gauche|gauche|droite", "focal": "point focal", "titleSynergy": "comment l'image complète le titre sans le répéter", "why": "pourquoi ça donnerait envie de cliquer, avec [n]", "sketch": [{"kind": "fond|split|visage|personne|objet|texte|fleche|cercle|halo", "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1, "label": "…", "color": "#hex", "emotion": "…"}], "imagePrompt": "English prompt for an image model: 16:9 photographic composition, subject, expression, lighting, colors, background — NO text, NO letters, NO logos"}`,
    'Règles : 3 éléments forts maximum ; texte ≤ 3 mots et jamais la reprise du titre ; coin bas-droit libre (durée) ; contraste fort lisible en 168×94 ; croquis : x,y = coin haut-gauche de la boîte, origine en haut à gauche ; pour « fleche », (x,y) est le départ et (x+w, y+h) la pointe.',
  ].filter(Boolean).join('\n')));
  const raw = await askClaudeJSON<{ concepts?: unknown[] } | unknown[]>({
    system: `${EXPERT}\nTu conçois des miniatures à fort taux de clic, simples, lisibles en petit format et honnêtes (la vidéo doit tenir la promesse).${principlesBlock(principles)}`,
    messages: [{ role: 'user', content }], maxTokens: 1500 * n + 800, signal: ctx.signal,
  });
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.concepts) ? raw.concepts : [];
  if (!list.length) throw new Error('Claude n\'a proposé aucun concept : reformule le brief.');
  return list.slice(0, n).map((c, i) => normalizeConcept(c, principles, i));
}

// ── 4. Synthèse d'une niche (texte seul, à partir des analyses) ─────────────
export interface NicheRule { rule: string; evidence: string; citations: string[] }
export interface NicheSynthesis { summary: string; rules: NicheRule[]; opportunities: string[]; at: number }
export async function synthesizeNiche(niche: string, ins: NicheInsights, samples: { title: string; views: number; ratio?: number; v: VisionAnalysis }[], principles: Principle[], signal?: AbortSignal): Promise<NicheSynthesis> {
  const lines = samples.slice(0, 40).map((s, i) => `${i + 1}. « ${s.title} » — ${formatNum(s.views)} vues${s.ratio != null ? `, ${s.ratio.toFixed(1)}× abonnés` : ''} — visage:${s.v.face ? s.v.emotion : 'non'}, texte:${s.v.text ? `« ${s.v.text} »` : 'aucun'}, éléments:${s.v.elementCount}, composition:${s.v.layout}, couleurs:${s.v.colorStrategy}`);
  const raw = await askClaudeJSON<{ summary?: unknown; rules?: unknown[]; opportunities?: unknown[] }>({
    system: `${EXPERT}\nTu tires des règles actionnables de données réelles, en citant les chiffres.${principlesBlock(principles)}`,
    prompt: `Niche « ${niche} ».\n${insightsSummary(ins)}\n\nMiniatures analysées :\n${lines.join('\n')}\n\nRéponds avec {"summary": "3 phrases", "rules": [{"rule": "règle actionnable", "evidence": "chiffres de la niche qui la justifient", "principles": [n]}] (4 à 7 règles), "opportunities": ["2 ou 3 façons de se démarquer de la niche"]}`,
    maxTokens: 2500, signal,
  });
  const rules: NicheRule[] = (Array.isArray(raw.rules) ? raw.rules : []).map(r => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const t = extractCitations(String(o.rule ?? ''), principles), ev = extractCitations(String(o.evidence ?? ''), principles);
    const idx = (Array.isArray(o.principles) ? o.principles : []).map(n => principles[Number(n) - 1]).filter(Boolean);
    return { rule: t.text, evidence: ev.text, citations: [...new Set([...t.citations, ...ev.citations, ...idx.map(p => extractCitations(`[${principles.indexOf(p) + 1}]`, principles).citations[0])])].filter(Boolean) };
  }).filter(r => r.rule);
  return { summary: String(raw.summary ?? ''), rules, opportunities: (Array.isArray(raw.opportunities) ? raw.opportunities : []).map(String).slice(0, 4), at: Date.now() };
}
