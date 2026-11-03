// Appels Claude de l'assistant script. La méthode de l'utilisateur (docs/methode-scripting.md) est le cœur
// de chaque prompt système ; les principes de la base de connaissances sont injectés et cités par [n].
import { askClaude, askClaudeJSON } from '../../claude/api';
import { formatCitation, principlesToPrompt, searchPrinciples, type Principle, type Topic } from '../../knowledge/api';
import type { ScoreResult } from '../scores';
import { METHODE, ISSUE_INFO, TECHNIQUES, styleDef, techniqueDef, SECTION_DEFS, type IssueType, type ScriptStyle } from './method';
import { analyzeScript, blocksFromPlainText, fmtClock, hookLocal, type ScriptAnalysis } from './heuristics';
import { stripFences } from './doc';
import { parseJsonLines, toAnnotation, type Annotation, type AnalysisSummary, type TBlock, type VideoAnalysis } from './analysis';
import type { AiSuggestion, EvalKey, IdeaTest, ScriptEval, ScriptMeta } from './store';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

// ── Base de connaissances ─────────────────────────────────────
export async function gatherPrinciples(queries: { q: string; topic?: Topic; k?: number }[], max = 8): Promise<Principle[]> {
  const res = await Promise.all(queries.map(x => searchPrinciples(x.q, { topic: x.topic, k: x.k ?? 3 }).catch(() => [] as Principle[])));
  const seen = new Set<string>(); const out: Principle[] = [];
  for (const list of res) for (const p of list) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
  return out.slice(0, max);
}
const citeCache = new Map<IssueType, { at: number; p: Promise<string | null> }>();
/** Citation sourcée (formatCitation) du principe qui correspond à un conseil local, s'il existe. */
export function citationFor(type: IssueType): Promise<string | null> {
  const hit = citeCache.get(type);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const info = ISSUE_INFO[type];
  const p = searchPrinciples(info.query, { topic: info.topic, k: 1 })
    .then(ps => { const x = ps[0]; return x && (x.score == null || x.score >= 0.35) ? formatCitation(x) : null; })
    .catch(() => null);
  citeCache.set(type, { at: Date.now(), p });
  return p;
}

// ── Prompts ───────────────────────────────────────────────────
export const systemBase = (extra = '') => `Tu es l'assistant script de Prisme, une app pour créateurs YouTube. Tu appliques STRICTEMENT la méthode de scripting de l'utilisateur reproduite ci-dessous (méthode Squiduu / MrBeast) : c'est ta référence absolue, et tu t'y réfères par ses points (« point 4 — boucles ouvertes »…). Tu réponds en français, de façon directe, sans préambule.

<methode>
${METHODE}
</methode>${extra}`;
export const knowledgeBlock = (ps: Principle[]) => ps.length
  ? `\n\n<base_de_connaissances>\nPrincipes sourcés tirés des tutos de gros YouTubeurs. Quand tu t'appuies sur l'un d'eux, cite-le par son numéro [n].\n${principlesToPrompt(ps)}\n</base_de_connaissances>`
  : '';

export function briefText(meta: ScriptMeta, title?: string): string {
  const st = styleDef(meta.style);
  const words = Math.round((meta.targetSec / 60) * meta.wpm);
  return [
    `- Titre prévu : ${meta.plannedTitle || title || '(non défini)'}`,
    `- Idée : ${meta.idea || '(non définie)'}`,
    meta.ideaTest?.concept ? `- Concept en une phrase : ${meta.ideaTest.concept}` : '',
    `- Style : ${st.label} — structure type « ${st.structure} ». ${st.tip}`,
    `- Durée cible : ${fmtClock(meta.targetSec)} → environ ${words} mots parlés (lignes « Voix » uniquement) à ${meta.wpm} mots/min.`,
    meta.plannedThumbnail ? `- Miniature prévue : ${meta.plannedThumbnail} (la 1re phrase doit la confirmer)` : '',
    meta.payoff ? `- Payoff prévu (on écrit la fin avant le début : tout le script y mène) : ${meta.payoff}` : '',
    meta.ideaTest ? `- Tests de l'idée : compréhensible ${meta.ideaTest.comprehensible.note}/10, remarquable ${meta.ideaTest.remarquable.note}/10 (verdict : ${meta.ideaTest.verdict}).` : '',
  ].filter(Boolean).join('\n');
}

// ── Étape 0 : tester l'idée ───────────────────────────────────
export async function testIdea(idea: string, style: ScriptStyle, signal?: AbortSignal): Promise<IdeaTest> {
  const ps = await gatherPrinciples([{ q: `trouver une bonne idée de vidéo ${idea}`, topic: 'packaging', k: 3 }, { q: 'concept de vidéo remarquable', topic: 'general', k: 2 }], 4);
  const st = styleDef(style);
  const r = await askClaudeJSON<Record<string, unknown>>({
    system: systemBase(knowledgeBlock(ps)),
    prompt: `Applique l'« Étape 0 — Valider l'idée avant d'écrire » de la méthode à cette idée de vidéo (style ${st.label}).
Idée : « ${idea} »

Sois exigeant et honnête : une idée banale, floue ou déjà vue échoue. Test 1 « compréhensible en 2 secondes » : n'importe qui comprend le concept et l'objectif immédiatement. Test 2 « remarquable » : quelque chose que personne ne fait ou qui semble fou (test MrBeast : si le spectateur ne clique pas, il se demande toute la journée ce qu'il a manqué). Si l'idée échoue, propose des variantes qui passent les deux tests.

JSON attendu :
{"comprehensible":{"ok":true,"note":7,"pourquoi":"1 à 2 phrases"},"remarquable":{"ok":false,"note":4,"pourquoi":"1 à 2 phrases"},"verdict":"go | retravailler | changer","concept":"le concept en une phrase intrigante","variantes":["3 versions plus fortes de l'idée, une phrase chacune"],"titres":["3 titres possibles"],"miniature":"une miniature qui se lit en 1 seconde","payoff":"le payoff final le plus satisfaisant"}`,
    maxTokens: 1600, signal,
  });
  const v = (x: unknown): IdeaTest['comprehensible'] => {
    const o = (x ?? {}) as Record<string, unknown>;
    const note = clamp(Number(o.note) || 0, 0, 10);
    return { ok: typeof o.ok === 'boolean' ? o.ok : note >= 7, note, pourquoi: String(o.pourquoi ?? '') };
  };
  const verdict = String(r.verdict ?? '').toLowerCase();
  const strs = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 5) : []);
  return {
    idea, at: Date.now(), comprehensible: v(r.comprehensible), remarquable: v(r.remarquable),
    verdict: verdict.startsWith('go') ? 'go' : verdict.startsWith('chang') ? 'changer' : 'retravailler',
    concept: String(r.concept ?? ''), variantes: strs(r.variantes), titres: strs(r.titres), miniature: String(r.miniature ?? ''), payoff: String(r.payoff ?? ''),
  };
}

// ── Génération d'un script complet (streaming) ────────────────
function formatRules(meta: ScriptMeta): string {
  const short = meta.style === 'short' || meta.targetSec <= 75;
  return `

FORMAT DE SORTIE OBLIGATOIRE (Markdown, sans préambule ni commentaire hors script, jamais de tableau) :
- Une section H2 par bloc de la structure guidée, dans cet ordre exact et avec ces titres exacts :
${SECTION_DEFS.map(d => `  ## ${d.heading}`).join('\n')}
- « Corps — montée de tension » = la première moitié des paliers (obstacles réels, échecs écrits, fils parallèles) ; « Re-hooks réguliers » = la seconde moitié : re-hook de mi-vidéo (élément planté révélé / nouvelle arme) puis les paliers les plus intenses, chacun relancé.
- Dans chaque section, un ou plusieurs beats titrés en H3 : « ### [m:ss] titre court du beat » (timing estimé au débit indiqué).
- Sous chaque beat, une ligne par élément, chacune sur sa propre ligne :
  **Voix :** le texte parlé exact, oral, phrases courtes (seule ligne lue à voix haute)
  **Visuel :** plan, B-roll, texte à l'écran
  **Son :** musique, SFX
  **Boucle :** ouverte « question » ou fermée « question » (uniquement quand une boucle s'ouvre ou se ferme)
- Une relance (question, teaser, rebondissement, palier) au moins toutes les 30 secondes de voix${short ? ' ; pour un Short, chaque section peut tenir en un seul beat d\'une ligne de voix' : ''}.
- Termine par la section :
  ## Récap des boucles
  Promesse du titre tenue à m:ss
  - « boucle » : ouverte à m:ss → fermée à m:ss
- Si tu t'appuies sur un principe de la base de connaissances, ajoute [n] à la fin de la ligne **Boucle :** ou **Visuel :** concernée (jamais dans la voix).`;
}
function referenceText(ref: VideoAnalysis): string {
  const byBlock = new Map<number, Annotation[]>();
  for (const a of ref.annotations) byBlock.set(a.i, [...(byBlock.get(a.i) ?? []), a]);
  const rows = ref.blocks.filter(b => byBlock.has(b.i)).slice(0, 80).map(b =>
    `[${fmtClock(b.start)}] ${(byBlock.get(b.i) ?? []).map(a => `${techniqueDef(a.kind).label}${a.why ? ` (${a.why})` : ''}`).join(' + ')} — « ${b.text.slice(0, 140)} »`);
  const s = ref.summary;
  return `Vidéo de référence : « ${ref.title} »${ref.channel ? ` — ${ref.channel}` : ''} (${fmtClock(ref.durationSec)})
${s ? `Structure : ${s.structure}\nHook : ${s.hook}\nLeçons : ${s.lecons.join(' ; ')}` : ''}
Techniques annotées, dans l'ordre :
${rows.join('\n')}`;
}

export interface GenerateInput {
  meta: ScriptMeta; title: string; mode: 'new' | 'rewrite' | 'adapt';
  current?: string; reference?: VideoAnalysis; onText: (full: string) => void; signal?: AbortSignal;
}
export async function generateScript(i: GenerateInput): Promise<{ markdown: string; principles: Principle[] }> {
  const st = styleDef(i.meta.style);
  const ps = await gatherPrinciples([
    { q: `${i.meta.idea} ${st.label} écrire un script`, topic: 'script', k: 4 },
    { q: 'hook premières secondes', topic: 'hook', k: 2 },
    { q: 'rétention boucles ouvertes re-hook', topic: 'retention', k: 2 },
  ], 8);
  const words = Math.round((i.meta.targetSec / 60) * i.meta.wpm);
  const task = i.mode === 'rewrite'
    ? `Réécris complètement mon script en appliquant la méthode : garde mes idées, mes faits et mes blagues, mais corrige le hook, la promesse, les boucles, l'escalade, le rythme et la sortie.\n\nMon script actuel :\n<script>\n${i.current ?? ''}\n</script>`
    : i.mode === 'adapt' && i.reference
      ? `Écris le script complet de MA vidéo en appliquant les techniques de la vidéo de référence ci-dessous (même type de hook, même rythme de boucles et de re-hooks, même escalade, même façon de livrer le payoff) — sans copier son contenu.\n\n<reference>\n${referenceText(i.reference)}\n</reference>${i.current ? `\n\nMon brouillon actuel (à réutiliser) :\n<script>\n${i.current}\n</script>` : ''}`
      : 'Écris le script complet de cette vidéo.';
  const markdown = await askClaude({
    system: systemBase(knowledgeBlock(ps)) + formatRules(i.meta),
    prompt: `${task}\n\nBrief :\n${briefText(i.meta, i.title)}\n\nRespecte le volume : environ ${words} mots sur l'ensemble des lignes **Voix :**.`,
    maxTokens: clamp(3000 + words * 4, 4000, 32000),
    onText: (_d, full) => i.onText(full),
    signal: i.signal,
  });
  return { markdown: appendSources(stripFences(markdown), ps), principles: ps };
}
/** Ajoute une section « Sources » listant les principes cités par [n]. */
export function appendSources(md: string, ps: Principle[]): string {
  const cited = [...new Set([...md.matchAll(/\[(\d{1,2})\]/g)].map(m => Number(m[1])))].filter(n => n >= 1 && n <= ps.length).sort((a, b) => a - b);
  if (!cited.length) return md;
  return `${md.trimEnd()}\n\n## Sources\n${cited.map(n => `- [${n}] ${formatCitation(ps[n - 1])}`).join('\n')}\n`;
}

// ── Évaluation en direct (rapide, débouncée) ──────────────────
export const EVAL_LABELS: Record<EvalKey, string> = { hook: 'Force du hook', promesse: 'Clarté de la promesse', boucles: 'Boucles ouvertes', escalade: 'Escalade', rythme: 'Rythme', payoff: 'Payoff' };
export async function evaluateScript(i: { promptText: string; meta: ScriptMeta; title: string; analysis: ScriptAnalysis; signal?: AbortSignal }): Promise<Omit<ScriptEval, 'hash' | 'at'>> {
  const ps = await gatherPrinciples([{ q: 'hook rétention boucles ouvertes payoff', topic: 'retention', k: 3 }, { q: 'structure de script escalade promesse', topic: 'script', k: 3 }], 6);
  const a = i.analysis;
  const mesures = [
    `Durée estimée ${fmtClock(a.durationSec)}${a.targetSec ? ` pour ${fmtClock(a.targetSec)} visées` : ''} (${a.words} mots à ${a.wpm} mots/min).`,
    `Boucles ouvertes détectées : ${a.openLoops} · questions : ${a.questions} · paliers : ${a.escalations} · rebondissements : ${a.twists}.`,
    `Moments morts (passages sans relance) : ${a.deadZones.map(z => `${fmtClock(z.t)} (${Math.round(z.dur)} s)`).join(', ') || 'aucun'}.`,
    `Première phrase ≈ ${a.hookSec ?? 0} s · objectif annoncé à ${a.promiseSec != null ? fmtClock(a.promiseSec) : 'non détecté'}.`,
  ].join('\n');
  const r = await askClaudeJSON<Record<string, unknown>>({
    fast: true, maxTokens: 2200, signal: i.signal,
    system: systemBase(knowledgeBlock(ps)),
    prompt: `Évalue ce script YouTube EN COURS D'ÉCRITURE avec la checklist de critique de la méthode. Il peut être incomplet : note ce qui existe ; une partie encore vide reçoit une note basse avec la raison « à écrire ».

Brief :
${briefText(i.meta, i.title)}

Mesures locales (fiables pour le timing) :
${mesures}

Script (horodatage estimé entre crochets ; seules les lignes de voix sont dites à l'oral) :
<script>
${i.promptText}
</script>

JSON attendu :
{"notes":{"hook":{"note":0,"raison":""},"promesse":{"note":0,"raison":""},"boucles":{"note":0,"raison":""},"escalade":{"note":0,"raison":""},"rythme":{"note":0,"raison":""},"payoff":{"note":0,"raison":""}},"global":0,"premierMomentMort":"extrait EXACT du premier passage sans question ouverte (là où le spectateur part), ou null","suggestions":[{"extrait":"citation EXACTE de 4 à 25 mots copiée d'une seule ligne du script","conseil":"correction concrète en une phrase, ton direct","type":"hook | promesse | boucle | escalade | rythme | payoff | cta | sponsor","principe":null}]}
Notes sur 10. « raison » : une phrase courte et actionnable. Au plus 5 suggestions, les plus impactantes d'abord ; « principe » = numéro [n] du principe de la base de connaissances utilisé, sinon null.`,
  });
  const notesRaw = (r.notes ?? {}) as Record<string, { note?: unknown; raison?: unknown }>;
  const notes = Object.fromEntries((Object.keys(EVAL_LABELS) as EvalKey[]).map(k => [k, { note: round1(clamp(Number(notesRaw[k]?.note) || 0, 0, 10)), raison: String(notesRaw[k]?.raison ?? '') }])) as ScriptEval['notes'];
  const vals = Object.values(notes).map(n => n.note);
  const sugg = (Array.isArray(r.suggestions) ? r.suggestions : []).slice(0, 6).map((x): AiSuggestion | null => {
    const o = x as Record<string, unknown>;
    const extrait = String(o.extrait ?? '').trim(); const conseil = String(o.conseil ?? '').trim();
    if (!conseil) return null;
    const n = Number(o.principe);
    const p = Number.isInteger(n) && n >= 1 && n <= ps.length ? ps[n - 1] : undefined;
    return { extrait, conseil, type: String(o.type ?? 'rythme'), principe: p ? n : null, citation: p ? formatCitation(p) : undefined };
  }).filter((x): x is AiSuggestion => !!x);
  const global = Number(r.global);
  return {
    notes, global: round1(clamp(Number.isFinite(global) && global > 0 ? global : vals.reduce((s, v) => s + v, 0) / vals.length, 0, 10)),
    premierMomentMort: typeof r.premierMomentMort === 'string' && r.premierMomentMort.trim() ? r.premierMomentMort.trim() : null,
    suggestions: sugg,
  };
}

// ── « Appliquer » : réécriture d'un passage ───────────────────
export async function rewritePassage(i: {
  passage: string; before: string; after: string; message: string; fix: string; meta: ScriptMeta; title: string;
  onText?: (full: string) => void; signal?: AbortSignal;
}): Promise<string> {
  const ps = await gatherPrinciples([{ q: i.message, k: 2 }], 2);
  const txt = await askClaude({
    system: systemBase(knowledgeBlock(ps)) + `

Tu réécris UNIQUEMENT le passage fourni pour corriger le problème signalé, selon la méthode. Garde le sens, les faits, les blagues et le ton oral du créateur, dans la même langue que le passage. Conserve la structure en lignes : si des lignes commencent par « Voix : », « Visuel : », « Son : » ou « Boucle : », garde ces libellés (en gras, ex. **Voix :**). Une ligne par paragraphe. Réponds UNIQUEMENT avec le passage réécrit : pas de guillemets autour, pas de titre, pas de commentaire, pas de référence [n].`,
    prompt: `Problème : ${i.message}\nConsigne : ${i.fix}\n\nBrief :\n${briefText(i.meta, i.title)}\n\nContexte juste avant (ne pas réécrire) :\n«${i.before}»\n\nPASSAGE À RÉÉCRIRE :\n<<<\n${i.passage}\n>>>\n\nContexte juste après (ne pas réécrire) :\n«${i.after}»`,
    maxTokens: clamp(Math.ceil(i.passage.length / 2) + 600, 700, 4000),
    onText: i.onText ? (_d, full) => i.onText!(cleanRewrite(full)) : undefined,
    signal: i.signal,
  });
  return cleanRewrite(txt);
}
export const cleanRewrite = (s: string) => stripFences(s).replace(/^\s*<<<\s*/, '').replace(/\s*>>>\s*$/, '').replace(/^PASSAGE[^\n]*\n/i, '').trim();

// ── Mode « Analyser un script » : annotation en flux JSON Lines ──
export async function annotateTranscript(i: {
  blocks: TBlock[]; title: string; channel?: string; timed: boolean;
  onBlock: (index: number, annotations: Annotation[]) => void; onSummary: (s: AnalysisSummary) => void; signal?: AbortSignal;
}): Promise<void> {
  const lines = i.blocks.map(b => `[${b.i}] (${fmtClock(b.start)}-${fmtClock(b.end)}) ${b.text}`).join('\n');
  const kinds = TECHNIQUES.map(t => `- ${t.kind} : ${t.label} — ${t.desc}`).join('\n');
  let consumed = 0;
  const handle = (raw: unknown) => {
    const o = raw as Record<string, unknown>;
    if (o && typeof o === 'object' && 'resume' in o) {
      const s = (o.resume ?? {}) as Record<string, unknown>;
      const arr = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 8) : []);
      i.onSummary({ structure: String(s.structure ?? ''), hook: String(s.hook ?? ''), lecons: arr(s.lecons), techniquesCles: arr(s.techniquesCles) });
      return;
    }
    const idx = Number(o?.i);
    if (Number.isInteger(idx)) i.onBlock(idx, toAnnotation(o, i.blocks.length));
  };
  const full = await askClaude({
    system: systemBase(`

Tu annotes la transcription d'une vidéo YouTube à succès pour en extraire les techniques de rétention de la méthode, avec cette taxonomie (utilise le type exact) :
${kinds}

Réponds UNIQUEMENT en JSON Lines (un objet JSON par ligne, sans texte autour, sans balise), dans l'ordre des blocs :
{"i": <numéro du bloc>, "techniques": [{"type": "<type exact>", "explication": "pourquoi c'est efficace, en une phrase en français", "citation": "extrait exact du bloc"}]}
Une ligne par bloc qui contient au moins une technique (ignore les autres). Termine par une dernière ligne :
{"resume": {"structure": "la structure de la vidéo en 2-3 phrases (blocs et minutages)", "hook": "type de hook utilisé et pourquoi il marche", "lecons": ["5 leçons concrètes à appliquer à mes scripts"], "techniquesCles": ["les 3 à 5 techniques qui portent la vidéo"]}}`),
    prompt: `Vidéo : « ${i.title} »${i.channel ? ` — ${i.channel}` : ''}${i.timed ? '' : '\nAttention : les horodatages sont estimés (transcription sans minutage).'}

Transcription découpée en blocs horodatés :
${lines}`,
    maxTokens: clamp(2500 + i.blocks.length * 170, 4000, 32000),
    onText: (_d, f) => {
      const { items, rest } = parseJsonLines(f.slice(consumed));
      consumed = f.length - rest.length;
      items.forEach(handle);
    },
    signal: i.signal,
  });
  const tail = full.slice(consumed).trim().replace(/```$/, '').trim();
  if (tail) { try { handle(JSON.parse(tail)); } catch { /* ligne finale incomplète ignorée */ } }
}

// ── scoreHook (contrat src/assistants/scores.ts) ──────────────
export async function scoreHookImpl(text: string): Promise<ScoreResult> {
  const a = analyzeScript(blocksFromPlainText(text), {});
  const local = hookLocal(a);
  const ps = await gatherPrinciples([{ q: 'hook en moins de 5 secondes', topic: 'hook', k: 3 }], 3);
  const citations = ps.map(formatCitation);
  if (!a.sentences.length) return { score: 0, reasons: ['Aucun texte de hook à évaluer.'], citations };
  const hook = a.sentences.filter(s => s.t < 35).map(s => s.text).join(' ');
  try {
    const r = await askClaudeJSON<{ note?: unknown; raisons?: unknown }>({
      fast: true, maxTokens: 700, system: systemBase(knowledgeBlock(ps)),
      prompt: `Note sur 10 ce hook (≈ 30 premières secondes d'une vidéo YouTube) selon les points 1 et 2 de la méthode : hook < 5 s qui confirme la miniature, pas de « salut à tous », objectif + enjeux + plan annoncés avant 30 s, boucle ouverte immédiate.\n\nHook :\n« ${hook} »\n\nJSON attendu : {"note": 0, "raisons": ["3 raisons courtes et actionnables"]}`,
    });
    const note = clamp(Number(r.note) || 0, 0, 10);
    const raisons = Array.isArray(r.raisons) ? r.raisons.map(String).filter(Boolean).slice(0, 4) : [];
    return { score: round1(note * 0.7 + local.score * 0.3), reasons: [...raisons, ...local.reasons.slice(0, 3)], citations };
  } catch (e) {
    return { score: local.score, reasons: [...local.reasons, `Évaluation Claude indisponible : ${(e as Error).message}`], citations };
  }
}
