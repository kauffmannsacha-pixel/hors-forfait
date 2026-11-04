// Construction du contexte envoyé à Claude pour le rapport IA, et normalisation de sa réponse (fonctions pures).
import { fmtClock, fmtInt, fmtNum, fmtPct, fmtPts, truncate } from './format';
import { EVENT_LABELS, type RetentionEvent } from './events';
import { sampleAt, summarizeRetention, type RetentionSample } from './retention';
import { sentenceAt, worstSentences, type Sentence, type SentenceStat } from './transcript';
import type { Chapter } from './chapters';

export type AxisId = 'hook' | 'intrigue' | 'rythme' | 'payoff' | 'miniature' | 'titre';
export const AXIS_IDS: AxisId[] = ['hook', 'intrigue', 'rythme', 'payoff', 'miniature', 'titre'];
export const AXIS_LABELS: Record<AxisId, string> = { hook: 'Hook', intrigue: 'Intrigue', rythme: 'Rythme', payoff: 'Payoff', miniature: 'Miniature', titre: 'Titre' };

export interface ContextVideo { id: string; title: string; description: string; channelTitle: string; publishedAt: string; durationSec: number; views: number; likes: number; comments: number; tags?: string[] }
export interface ContextInput {
  video: ContextVideo;
  mine: boolean;
  series?: RetentionSample[];
  events?: RetentionEvent[];
  sentences?: Sentence[];
  stats?: SentenceStat[];
  chapters?: Chapter[];
  hasRelative?: boolean;
  metrics?: { avgDuration?: number | null; avgPct?: number | null; subsGained?: number | null; subsLost?: number | null; shares?: number | null } | null;
  reach?: { impressions: number; ctr: number | null; firstDay?: string | null; lastDay?: string | null } | null;
  traffic?: { label: string; share: number }[] | null;
  now?: number;
}

const line = (t: number, text: string) => `[${fmtClock(t)}] ${text}`;

/** Transcription horodatée tenant dans un budget de caractères : début, fin et zones d'événements en entier, le reste échantillonné. */
export function transcriptForPrompt(sentences: Sentence[], durationSec: number, events: RetentionEvent[] = [], budget = 30_000): string {
  const all = sentences.map(s => line(s.start, s.text));
  const full = all.join('\n');
  if (full.length <= budget) return full;
  const keep = new Set<number>();
  sentences.forEach((s, i) => {
    if (s.start < 180 || s.end > durationSec - 120) keep.add(i);
    if (events.some(e => s.end >= e.start - 15 && s.start <= e.end + 15)) keep.add(i);
  });
  let size = [...keep].reduce((n, i) => n + all[i].length + 1, 0);
  const rest = sentences.map((_, i) => i).filter(i => !keep.has(i));
  if (size < budget && rest.length) {
    const avg = rest.reduce((n, i) => n + all[i].length + 1, 0) / rest.length;
    const room = Math.max(0, Math.floor((budget - size) / Math.max(1, avg)));
    const every = Math.max(1, Math.ceil(rest.length / Math.max(1, room)));
    rest.forEach((i, k) => { if (k % every === 0 && size + all[i].length < budget) { keep.add(i); size += all[i].length + 1; } });
  }
  const out: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (prev >= 0 && i > prev + 1) out.push('[…]');
    out.push(all[i]);
    prev = i;
  }
  return out.join('\n').slice(0, budget + 2000);
}

/** Contexte factuel (données réelles) pour le rapport IA. */
export function buildReportContext(inp: ContextInput): string {
  const v = inp.video, D = v.durationSec, now = inp.now ?? Date.now();
  const ageDays = Math.max(0, (now - new Date(v.publishedAt).getTime()) / 86_400_000);
  const out: string[] = [];
  out.push('# Vidéo');
  out.push(`Titre : « ${v.title} » (${[...v.title].length} caractères)`);
  out.push(`Chaîne : ${v.channelTitle} · ${inp.mine ? 'vidéo de l’utilisateur (données YouTube Analytics)' : 'vidéo publique (données publiques uniquement)'}`);
  out.push(`Publiée le ${v.publishedAt.slice(0, 10)} (il y a ${fmtNum(ageDays, 1)} j) · Durée : ${fmtClock(D)} (${Math.round(D)} s) · Format : ${D <= 180 ? 'court (Short probable)' : 'long'}`);
  out.push(`Vues : ${fmtInt(v.views)} · J’aime : ${fmtInt(v.likes)}${v.views ? ` (${fmtPct(v.likes / v.views, 2)} des vues)` : ''} · Commentaires : ${fmtInt(v.comments)}`);
  if (v.tags?.length) out.push(`Tags : ${v.tags.slice(0, 15).join(', ')}`);
  if (v.description) out.push(`Description (extrait) : ${truncate(v.description.replace(/\s+/g, ' '), 700)}`);

  out.push('\n# Packaging');
  if (inp.reach && inp.reach.impressions > 0) {
    out.push(`Impressions de la miniature : ${fmtInt(inp.reach.impressions)} · CTR : ${inp.reach.ctr != null ? fmtPct(inp.reach.ctr, 2) : 'inconnu'}${inp.reach.firstDay ? ` (rapports du ${inp.reach.firstDay} au ${inp.reach.lastDay})` : ''}`);
  } else out.push('Impressions / CTR : non disponibles pour cette analyse (juge la miniature sur l’image).');

  if (inp.metrics) {
    const m = inp.metrics;
    out.push('\n# Performance (YouTube Analytics)');
    out.push(`Durée moyenne regardée : ${m.avgDuration != null ? fmtClock(m.avgDuration) : '—'} · % moyen regardé : ${m.avgPct != null ? fmtNum(m.avgPct, 1) + ' %' : '—'} · Abonnés : +${fmtInt(m.subsGained ?? 0)} / −${fmtInt(m.subsLost ?? 0)} · Partages : ${fmtInt(m.shares ?? 0)}`);
  }
  if (inp.traffic?.length) out.push(`Sources de trafic : ${inp.traffic.slice(0, 5).map(t => `${t.label} ${fmtPct(t.share, 0)}`).join(' · ')}`);

  const series = inp.series ?? [];
  const sentences = inp.sentences ?? [];
  if (series.length) {
    const sum = summarizeRetention(series, D);
    out.push('\n# Rétention d’audience (audienceWatchRatio : 100 mesures YouTube interpolées à la seconde)');
    if (sum) {
      out.push(`Repères : ${fmtClock(sum.early.t)} → ${fmtPct(sum.early.watch, 0)} · mi-parcours → ${fmtPct(sum.middle, 0)} · fin → ${fmtPct(sum.end, 0)} · moyenne ${fmtPct(sum.meanWatch, 0)}`);
      if (sum.meanRelative != null) out.push(`Performance relative moyenne : ${fmtNum(sum.meanRelative, 2)} (0,5 = médiane des vidéos YouTube de durée similaire ; > 0,5 = mieux)`);
    }
    const pts: string[] = [];
    const step = D / 50;
    for (let i = 0; i <= 50; i++) { const t = i * step; pts.push(`${fmtClock(t)} ${fmtPct(sampleAt(series, t), 0)}`); }
    out.push(`Courbe (tous les 2 %) : ${pts.join(' | ')}`);
    if (inp.events?.length) {
      out.push('Événements détectés automatiquement :');
      for (const e of inp.events) {
        const s = sentenceAt(sentences, e.at, 2);
        out.push(`- [${fmtClock(e.start)}–${fmtClock(e.end)}] ${EVENT_LABELS[e.kind]} ${fmtPts(e.deltaPts)} (pic à ${fmtClock(e.at)})${s ? ` — phrase : « ${truncate(s.text, 160)} »` : ''}`);
      }
    }
    const worst = worstSentences(inp.stats ?? [], 6, { after: Math.min(30, D * 0.1) });
    if (worst.length) {
      out.push('Phrases qui font le plus décrocher (perte par 10 s) :');
      for (const s of worst) out.push(`- [${fmtClock(s.start)}] ${fmtPts(s.ratePer10s)} / 10 s — « ${truncate(s.text, 160)} »`);
    }
  } else {
    out.push('\n# Rétention : non disponible (' + (inp.mine ? 'données Analytics pas encore prêtes' : 'vidéo d’une autre chaîne : seul son propriétaire y a accès') + ').');
  }
  if (inp.chapters?.length) out.push('\n# Chapitres\n' + inp.chapters.map(c => `${fmtClock(c.start)} ${c.title}`).join('\n'));
  if (sentences.length) out.push('\n# Transcription horodatée\n' + transcriptForPrompt(sentences, D, inp.events ?? []));
  else out.push('\n# Transcription : indisponible (juge le hook et le rythme avec prudence et dis-le).');
  return out.join('\n');
}

// ── Normalisation de la réponse de Claude ──
export interface RawAxis { id?: unknown; note?: unknown; explication?: unknown; moment?: unknown; conseil?: unknown; principes?: unknown }
export interface NormalizedAxis<P> { id: AxisId; score: number | null; explanation: string; moment: { t: number; label: string } | null; advice: string; principles: P[] }
export interface NormalizedReport<P> { summary: string; axes: NormalizedAxis<P>[]; priorities: string[]; overall: number | null }

const strip = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const ALIASES: Record<string, AxisId> = { hook: 'hook', accroche: 'hook', intrigue: 'intrigue', rythme: 'rythme', rhythm: 'rythme', pacing: 'rythme', payoff: 'payoff', miniature: 'miniature', thumbnail: 'miniature', titre: 'titre', title: 'titre' };

export function normalizeReport<P>(raw: unknown, principles: P[], durationSec: number): NormalizedReport<P> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { resume?: unknown; axes?: unknown; priorites?: unknown };
  const list = Array.isArray(r.axes) ? (r.axes as RawAxis[]) : [];
  const byId = new Map<AxisId, RawAxis>();
  for (const a of list) {
    const id = ALIASES[strip(String(a?.id ?? ''))];
    if (id && !byId.has(id)) byId.set(id, a);
  }
  const axes = AXIS_IDS.map((id): NormalizedAxis<P> => {
    const a = byId.get(id);
    if (!a) return { id, score: null, explanation: 'Axe non évalué par Claude.', moment: null, advice: '', principles: [] };
    const n = Number(a.note);
    const score = Number.isFinite(n) ? Math.round(Math.min(10, Math.max(0, n)) * 2) / 2 : null;
    let moment: NormalizedAxis<P>['moment'] = null;
    const m = a.moment as { t?: unknown; label?: unknown } | null | undefined;
    const t = Number(m?.t);
    if (m && Number.isFinite(t) && durationSec > 0) moment = { t: Math.min(durationSec, Math.max(0, t)), label: String(m.label ?? '').trim() };
    const idx = Array.isArray(a.principes) ? (a.principes as unknown[]).map(Number).filter(i => Number.isInteger(i) && i >= 1 && i <= principles.length) : [];
    return {
      id, score, moment,
      explanation: String(a.explication ?? '').trim(),
      advice: String(a.conseil ?? '').trim(),
      principles: [...new Set(idx)].map(i => principles[i - 1]),
    };
  });
  const scored = axes.filter(a => a.score != null).map(a => a.score as number);
  return {
    summary: String(r.resume ?? '').trim(),
    axes,
    priorities: Array.isArray(r.priorites) ? (r.priorites as unknown[]).map(x => String(x).trim()).filter(Boolean).slice(0, 5) : [],
    overall: scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null,
  };
}
