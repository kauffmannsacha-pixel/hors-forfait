// Extraction de principes par Claude (modèle rapide) à partir de fenêtres horodatées.
// La validation (pure, testée) recale chaque horodatage sur le début EXACT d'un segment de la fenêtre citée.
import { askClaudeJSON } from '../../claude/api';
import { fmtTime, TOPICS, type Topic } from '../api';
import type { TranscriptWindow } from '../transcript/chunk';
import { clip } from '../text';

export interface ExtractedPrinciple { topic: Topic; title: string; text: string; timestamp?: number; windowIndex: number }

const TOPIC_ALIASES: Record<string, Topic> = {
  script: 'script', scripting: 'script', writing: 'script', storytelling: 'script', ecriture: 'script', écriture: 'script', story: 'script',
  retention: 'retention', rétention: 'retention', pacing: 'retention', rythme: 'retention',
  hook: 'hook', hooks: 'hook', intro: 'hook', accroche: 'hook',
  thumbnail: 'thumbnail', thumbnails: 'thumbnail', miniature: 'thumbnail', miniatures: 'thumbnail',
  title: 'title', titles: 'title', titre: 'title', titres: 'title',
  packaging: 'packaging', idea: 'packaging', ideas: 'packaging', idée: 'packaging', ctr: 'packaging',
  analytics: 'analytics', data: 'analytics', stats: 'analytics', algorithm: 'analytics', algorithme: 'analytics',
  general: 'general', général: 'general', strategy: 'general', stratégie: 'general',
};
export const normalizeTopic = (t: unknown): Topic => {
  const k = String(t ?? '').trim().toLowerCase();
  return (TOPICS as string[]).includes(k) ? (k as Topic) : TOPIC_ALIASES[k] ?? 'general';
};

export const EXTRACTION_SYSTEM = `Tu es l'analyste de la base de connaissances de Prisme, un logiciel pour créateurs YouTube.
On te donne des extraits horodatés de la transcription d'une vidéo d'un créateur reconnu. Extrais UNIQUEMENT les principes actionnables
(conseils concrets et réutilisables) sur la création de vidéos YouTube : script, rétention, hook (accroche), miniatures, titres,
packaging (idée + titre + miniature), analytics, ou général (stratégie de chaîne).
Règles :
- N'invente rien : chaque principe doit être dit explicitement dans l'extrait. Pas de citation inventée.
- Reformule en français clair, en règle générale ou à l'impératif. Garde les chiffres, exemples et noms concrets cités.
- "title" : 3 à 12 mots, la règle en bref (ex. « Hook en moins de 5 secondes »).
- "text" : 1 à 3 phrases (320 caractères max) : la règle + le pourquoi ou l'exemple donné dans la vidéo.
- "topic" : une valeur parmi script, retention, hook, thumbnail, title, packaging, analytics, general.
- "extrait" : le numéro de l'extrait ; "t" : le nombre entre crochets de la ligne où le conseil est formulé (copie-le tel quel).
- Ignore sponsors, publicités, anecdotes sans leçon, banalités sans détail, autopromotion, appels à s'abonner.
- 0 à 4 principes par extrait ; une liste vide est une réponse valide.
Format : {"principles":[{"extrait":1,"t":123,"topic":"hook","title":"…","text":"…"}]}`;

/** Prompt utilisateur : extraits numérotés, une ligne par segment préfixée de son début en secondes. */
export function buildExtractionPrompt(meta: { creator: string; title: string }, windows: TranscriptWindow[], timed: boolean): string {
  const parts = windows.map((w, i) => {
    const head = `### Extrait ${i + 1}${timed ? ` (${fmtTime(w.start)} → ${fmtTime(w.end)})` : ''}`;
    const body = timed
      ? w.segments.map(s => `[${Math.floor(s.start)}] ${s.text.trim()}`).join('\n')
      : w.text;
    return head + '\n' + body;
  });
  return `Créateur : ${meta.creator}\nVidéo : « ${meta.title} »\n\n${parts.join('\n\n')}`;
}

/** Valide la sortie de Claude : sujet, longueurs, et horodatage recalé sur un segment réel de l'extrait. */
export function validateExtracted(raw: unknown, windows: TranscriptWindow[], timed: boolean): ExtractedPrinciple[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { principles?: unknown }).principles) ? (raw as { principles: unknown[] }).principles : []);
  const out: ExtractedPrinciple[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = clip(String(o.title ?? ''), 90);
    const text = clip(String(o.text ?? ''), 420);
    if (title.length < 3 || text.length < 15) continue;
    const ex = Number(o.extrait ?? o.excerpt ?? o.window);
    let wi = Number.isInteger(ex) && ex >= 1 && ex <= windows.length ? ex - 1 : -1;
    let timestamp: number | undefined;
    if (timed) {
      const t = typeof o.t === 'number' ? o.t : parseFloat(String(o.t ?? o.timestamp ?? ''));
      if (Number.isFinite(t)) {
        // Fenêtre citée, sinon celle qui contient t.
        if (wi < 0) wi = windows.findIndex(w => t >= Math.floor(w.start) && t <= Math.ceil(w.end));
        const pool = wi >= 0 ? windows[wi].segments : windows.flatMap(w => w.segments);
        let best: number | null = null, bestD = Infinity;
        for (const s of pool) { const d = Math.abs(Math.floor(s.start) - t); if (d < bestD) { bestD = d; best = s.start; } }
        if (best != null && bestD <= 45) timestamp = Math.floor(best);
        else if (wi >= 0) timestamp = Math.floor(windows[wi].start);
      } else if (wi >= 0) timestamp = Math.floor(windows[wi].start);
      if (wi < 0 && timestamp != null) wi = Math.max(0, windows.findIndex(w => timestamp! >= Math.floor(w.start) && timestamp! <= Math.ceil(w.end)));
    }
    out.push({ topic: normalizeTopic(o.topic), title, text, timestamp, windowIndex: Math.max(0, wi) });
  }
  return out;
}

/** Paquets de fenêtres pour limiter le nombre d'appels (≤ maxWindows et ≤ maxChars). */
export function batchWindows(windows: TranscriptWindow[], maxWindows = 5, maxChars = 7000): TranscriptWindow[][] {
  const out: TranscriptWindow[][] = []; let cur: TranscriptWindow[] = []; let chars = 0;
  for (const w of windows) {
    const n = w.text.length + w.segments.length * 8;
    if (cur.length && (cur.length >= maxWindows || chars + n > maxChars)) { out.push(cur); cur = []; chars = 0; }
    cur.push(w); chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Extrait les principes de toutes les fenêtres (appels séquentiels, annulables). */
export async function extractPrinciples(meta: { creator: string; title: string }, windows: TranscriptWindow[], opts: { timed: boolean; signal?: AbortSignal; onBatch?: (done: number, total: number) => void }): Promise<ExtractedPrinciple[]> {
  const batches = batchWindows(windows);
  const all: ExtractedPrinciple[] = [];
  for (let i = 0; i < batches.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('Annulé', 'AbortError');
    const b = batches[i];
    const raw = await askClaudeJSON<unknown>({ system: EXTRACTION_SYSTEM, prompt: buildExtractionPrompt(meta, b, opts.timed), fast: true, maxTokens: 3000, signal: opts.signal });
    for (const p of validateExtracted(raw, b, opts.timed)) all.push({ ...p, windowIndex: b[p.windowIndex]?.index ?? p.windowIndex });
    opts.onBatch?.(i + 1, batches.length);
  }
  return all;
}

// ── Documents (sans horodatage) ──────────────────────────────
export const DOCUMENT_SYSTEM = `Tu es l'analyste de la base de connaissances de Prisme, un logiciel pour créateurs YouTube.
On te donne un passage d'un document (guide, mémo, notes) écrit ou attribué à un créateur. Extrais UNIQUEMENT les principes actionnables
sur la création YouTube (script, rétention, hook, miniatures, titres, packaging, analytics, général).
Règles : n'invente rien ; reformule en français ; "title" 3 à 12 mots ; "text" 1 à 3 phrases (320 caractères max) avec les chiffres et exemples du texte ;
"topic" parmi script, retention, hook, thumbnail, title, packaging, analytics, general ; 0 à 12 principes ; liste vide si rien d'actionnable.
Format : {"principles":[{"topic":"…","title":"…","text":"…"}]}`;

export async function extractFromDocumentChunk(meta: { creator: string; title: string }, chunk: string, signal?: AbortSignal) {
  const raw = await askClaudeJSON<unknown>({ system: DOCUMENT_SYSTEM, prompt: `Auteur / créateur : ${meta.creator}\nDocument : « ${meta.title} »\n\n${chunk}`, fast: true, maxTokens: 4000, signal });
  return validateExtracted(raw, [], false);
}
