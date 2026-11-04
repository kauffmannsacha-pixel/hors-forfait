// Rapport IA : notes /10 (Hook, Intrigue, Rythme, Payoff, Miniature, Titre) fondées sur les données réelles
// (rétention, transcription, chapitres, métriques) + Claude Vision sur la miniature + principes sourcés.
import { askClaudeJSON, getModel, type ImageInput } from '../../../claude/api';
import { formatCitation, principlesToPrompt, searchPrinciples, type Principle, type Topic } from '../../../knowledge/api';
import { httpFetch } from '../../../db/http';
import { repo } from '../../../db/store';
import methode from '../../../../docs/methode-scripting.md?raw';
import { AXIS_IDS, buildReportContext, normalizeReport, type AxisId, type ContextInput } from '../lib/reportContext';

export interface Citation { principle: Principle; text: string }
export interface AxisReport { id: AxisId; score: number | null; explanation: string; moment: { t: number; label: string } | null; advice: string; citations: Citation[] }
export interface VideoReport {
  videoId: string; at: number; model: string;
  summary: string; overall: number | null; axes: AxisReport[]; priorities: string[];
  inputs: { retention: boolean; transcript: boolean; thumbnail: boolean; principles: number; ctr: boolean };
}

const AXIS_QUERIES: Record<AxisId, { topic: Topic; q: string }> = {
  hook: { topic: 'hook', q: 'hook accroche premières secondes confirmer la miniature' },
  intrigue: { topic: 'script', q: 'boucles ouvertes curiosité enjeux objectif annoncé re-hook' },
  rythme: { topic: 'retention', q: 'rythme temps morts pattern interrupt rétention escalade' },
  payoff: { topic: 'script', q: 'payoff fin promesse tenue récompense sortie sèche' },
  miniature: { topic: 'thumbnail', q: 'miniature contraste visage émotion lisibilité texte' },
  titre: { topic: 'title', q: 'titre curiosité clarté longueur cohérence miniature' },
};
const KEY = (id: string) => `stats.report.${id}`;

/** Principes de la base de connaissances (2 à 3 par axe, dédoublonnés). */
async function gatherPrinciples(): Promise<Principle[]> {
  const lists = await Promise.all(AXIS_IDS.map(id => searchPrinciples(AXIS_QUERIES[id].q, { topic: AXIS_QUERIES[id].topic, k: 3 }).catch(() => [] as Principle[])));
  const seen = new Set<string>();
  const out: Principle[] = [];
  for (const l of lists) for (const p of l) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
  return out.slice(0, 18);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Miniature en base64 (meilleure résolution disponible) pour Claude Vision. */
export async function thumbnailImage(video: { id: string; thumbnail: string }): Promise<ImageInput | null> {
  const urls = [`https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`, video.thumbnail, `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`].filter(Boolean);
  for (const url of urls) {
    try {
      const r = await httpFetch(url);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length < 3000) continue; // image grise « indisponible » de YouTube
      const ct = r.headers.get('content-type') ?? '';
      return { mediaType: ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg', base64: bytesToBase64(buf) };
    } catch { /* URL suivante */ }
  }
  return video.thumbnail ? { url: video.thumbnail } : null;
}

const SYSTEM = (principles: Principle[]) => `Tu es l'analyste vidéo de Prisme, expert YouTube. Tu évalues une vidéo DÉJÀ PUBLIÉE à partir de ses données réelles (rétention seconde par seconde, transcription horodatée, chapitres, métriques) et de sa miniature (image jointe), selon la méthode ci-dessous.

<methode>
${methode}
</methode>

Principes sourcés de la base de connaissances (cite-les par leur numéro dans "principes", seulement s'ils appuient vraiment ton conseil) :
${principles.length ? principlesToPrompt(principles) : '(aucun principe disponible : laisse "principes" vide)'}

Barème : notes de 0 à 10 (demi-points autorisés). 5 = moyen, 7 = bon, 8,5 = très bon, 10 = exceptionnel. Sois exigeant et justifie chaque note par des preuves précises tirées des données (valeur de rétention, phrase citée entre guillemets, horodatage).
Axes :
- hook : 0–30 s. La 1re phrase confirme-t-elle le titre et la miniature ? Comment se compare le décrochage de l'intro ?
- intrigue : boucles ouvertes, enjeux, objectif ou plan annoncé avant 30 s, questions laissées en suspens.
- rythme : temps morts, re-hooks, chutes dans le corps de la vidéo, débit, escalade par paliers.
- payoff : la fin tient-elle la promesse du titre ? Sortie sèche ou fin qui traîne ? (rétention finale, dernière phrase)
- miniature : analyse visuelle de l'image (visage/émotion, contraste, nombre d'éléments, texte, lisibilité en petit sur mobile, cohérence avec le titre) ; tiens compte du CTR s'il est fourni.
- titre : curiosité, clarté, longueur (~50 caractères visibles sur mobile), complémentarité avec la miniature, promesse tenue par la vidéo.
"moment" : l'instant précis (secondes, nombre entier) le plus révélateur pour l'axe ; il doit exister dans la transcription ou sur la courbe. Pour la miniature et le titre, l'instant où la vidéo tient (ou trahit) leur promesse. null uniquement si aucun instant n'a de sens.
"conseil" : une action concrète et simple (tutoiement), pour corriger cette vidéo (titre, miniature) ou réussir la prochaine.
Réponds en français, avec exactement ce JSON :
{"resume": string, "axes": [{"id": "hook"|"intrigue"|"rythme"|"payoff"|"miniature"|"titre", "note": number, "explication": string, "moment": {"t": number, "label": string} | null, "conseil": string, "principes": number[]}], "priorites": [string, string, string]}`;

/** Génère le rapport (Claude) et le mémorise en kv. */
export async function generateReport(input: ContextInput & { video: ContextInput['video'] & { thumbnail: string } }, signal?: AbortSignal): Promise<VideoReport> {
  const [principles, image, model] = await Promise.all([gatherPrinciples(), thumbnailImage(input.video), getModel()]);
  const context = buildReportContext(input);
  const raw = await askClaudeJSON<unknown>({
    system: SYSTEM(principles),
    prompt: `${context}\n\n${image ? 'La miniature de la vidéo est jointe en image.' : 'Miniature indisponible : note l’axe « miniature » à partir du titre et du CTR seulement, en le signalant.'}\nProduis le rapport JSON.`,
    images: image ? [image] : undefined,
    maxTokens: 6000,
    signal,
  });
  const n = normalizeReport(raw, principles, input.video.durationSec);
  const report: VideoReport = {
    videoId: input.video.id, at: Date.now(), model,
    summary: n.summary, overall: n.overall, priorities: n.priorities,
    axes: n.axes.map(a => ({ id: a.id, score: a.score, explanation: a.explanation, moment: a.moment, advice: a.advice, citations: a.principles.map(p => ({ principle: p, text: formatCitation(p) })) })),
    inputs: { retention: !!input.series?.length, transcript: !!input.sentences?.length, thumbnail: !!image, principles: principles.length, ctr: input.reach?.ctr != null },
  };
  await repo.kvSet(KEY(input.video.id), report).catch(() => undefined);
  return report;
}
export async function loadReport(videoId: string): Promise<VideoReport | undefined> {
  return (await repo.kvGet<VideoReport>(KEY(videoId)).catch(() => undefined)) ?? undefined;
}
