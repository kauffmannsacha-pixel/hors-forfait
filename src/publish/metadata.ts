// Construction et validation des métadonnées YouTube (videos.insert) — pure, testée.
import { chaptersToText, validateChapters } from './chapters';
import type { LinkItem, Privacy, VideoDraft } from './types';

export const TITLE_MAX = 100;            // snippet.title : 100 caractères, sans < >
export const DESCRIPTION_MAX_BYTES = 5000; // snippet.description : 5 000 octets, sans < >
export const TAGS_MAX = 500;             // snippet.tags : 500 caractères (virgules et guillemets comptés)
export const MOBILE_TITLE_VISIBLE = 50;  // ~50 caractères visibles dans le fil mobile
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
/** YouTube refuse « < » et « > » dans le titre et la description : on les remplace par ‹ ›. */
export const sanitizeYtText = (s: string) => s.replace(/</g, '‹').replace(/>/g, '›');

/** Découpe une saisie (virgules, retours à la ligne, #) en tags propres et dédoublonnés. */
export function normalizeTags(input: string | string[]): string[] {
  const parts = (Array.isArray(input) ? input : input.split(/[,\n;]/)).map(t => t.replace(/^#+/, '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const seen = new Set<string>(); const out: string[] = [];
  for (const p of parts) { const k = p.toLocaleLowerCase('fr-FR'); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}
/** Longueur comptée par YouTube : virgules entre tags + 2 guillemets pour un tag contenant une espace. */
export function tagsLength(tags: string[]): number {
  if (!tags.length) return 0;
  return tags.reduce((n, t) => n + [...t].length + (/\s/.test(t) ? 2 : 0), 0) + (tags.length - 1);
}
/** Garde les premiers tags tant que la limite de 500 caractères est respectée. */
export function fitTags(tags: string[], max = TAGS_MAX): string[] {
  const out: string[] = [];
  for (const t of tags) { if (tagsLength([...out, t]) <= max) out.push(t); }
  return out;
}
export function hashtags(tags: string[], n = 3): string {
  return tags.map(t => t.replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean).slice(0, n).map(t => '#' + t).join(' ');
}

// ── Templates de description ─────────────────────────────────
export interface DescriptionTemplate { id: string; name: string; body: string }
export const TEMPLATE_VARS: { key: string; label: string }[] = [
  { key: 'chapitres', label: 'Chapitres (00:00 Titre)' },
  { key: 'liens', label: 'Liens enregistrés de la chaîne' },
  { key: 'abonnement', label: "Lien d'abonnement à la chaîne" },
  { key: 'derniere_video', label: 'Dernière vidéo publiée' },
  { key: 'playlists', label: 'Playlists choisies' },
  { key: 'hashtags', label: '3 premiers tags en #hashtags' },
  { key: 'titre', label: 'Titre de la vidéo' },
  { key: 'chaine', label: 'Nom de la chaîne' },
  { key: 'date', label: 'Date de publication' },
];
export const DEFAULT_TEMPLATES: DescriptionTemplate[] = [
  {
    id: 'standard', name: 'Standard',
    body: '\n\n{{#chapitres}}⏱️ Chapitres\n{{chapitres}}\n\n{{/chapitres}}🔔 Abonne-toi : {{abonnement}}\n{{#derniere_video}}▶️ Ma dernière vidéo : {{derniere_video}}\n{{/derniere_video}}\n{{#liens}}🔗 Liens\n{{liens}}\n\n{{/liens}}{{hashtags}}',
  },
  {
    id: 'sponsor', name: 'Avec sponsor',
    body: '\n\n🤝 Merci à [SPONSOR] : [lien sponsor]\n\n{{#chapitres}}⏱️ Chapitres\n{{chapitres}}\n\n{{/chapitres}}{{#liens}}🔗 Liens\n{{liens}}\n\n{{/liens}}🔔 {{abonnement}}\n\n{{hashtags}}',
  },
  {
    id: 'short', name: 'Short',
    body: '\n\n{{hashtags}} #shorts',
  },
];

/** Rendu {{variable}} + sections conditionnelles {{#variable}}…{{/variable}} (affichées si la variable est non vide). */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  const sections = tpl.replace(/\{\{#([\w]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, k: string, inner: string) => (vars[k] ?? '').trim() ? inner : '');
  const out = sections.replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
  return out.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export const unknownVariables = (text: string) => [...new Set([...text.matchAll(/\{\{\s*[#/]?\s*([\w]+)\s*\}\}/g)].map(m => m[1]))].filter(k => !TEMPLATE_VARS.some(v => v.key === k));

export interface DescriptionContext {
  channelId: string; channelTitle: string;
  links: LinkItem[];
  playlists: { id: string; title: string }[];
  lastVideo?: { id: string; title: string } | null;
  date?: Date;
}
export const subscribeUrl = (channelId: string) => `https://www.youtube.com/channel/${channelId}?sub_confirmation=1`;
export const videoUrl = (videoId: string) => `https://youtu.be/${videoId}`;
export const studioUrl = (videoId: string) => `https://studio.youtube.com/video/${videoId}/edit`;
export const playlistUrl = (id: string) => `https://www.youtube.com/playlist?list=${id}`;

export function descriptionVars(d: VideoDraft, ctx: DescriptionContext): Record<string, string> {
  const chapters = d.includeChapters && d.chapters.length && !validateChapters(d.chapters, d.file?.durationSec).length ? chaptersToText(d.chapters, d.file?.durationSec) : '';
  const links = d.includeLinks ? ctx.links.filter(l => l.url.trim()).map(l => `${l.label.trim() ? l.label.trim() + ' : ' : ''}${l.url.trim()}`).join('\n') : '';
  const date = d.scheduleAt ? new Date(d.scheduleAt) : ctx.date ?? new Date();
  return {
    chapitres: chapters,
    liens: links,
    abonnement: ctx.channelId ? subscribeUrl(ctx.channelId) : '',
    derniere_video: ctx.lastVideo ? `${ctx.lastVideo.title} — ${videoUrl(ctx.lastVideo.id)}` : '',
    playlists: ctx.playlists.map(p => `${p.title} : ${playlistUrl(p.id)}`).join('\n'),
    hashtags: hashtags(d.tags),
    titre: d.title.trim(),
    chaine: ctx.channelTitle,
    date: date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

/** Description finale : variables résolues ; chapitres/liens ajoutés à la fin s'ils sont activés mais absents du texte. */
export function buildDescription(d: VideoDraft, ctx: DescriptionContext): string {
  const vars = descriptionVars(d, ctx);
  let text = d.description;
  const has = (k: string) => new RegExp(`\\{\\{\\s*#?${k}\\s*\\}\\}`).test(text);
  if (vars.chapitres && !has('chapitres')) text += '\n\n{{chapitres}}';
  if (vars.liens && !has('liens')) text += '\n\n{{liens}}';
  return sanitizeYtText(renderTemplate(text, vars));
}

// ── Ressource vidéo (corps de videos.insert) ─────────────────
export interface VideoResource {
  snippet: { title: string; description: string; tags?: string[]; categoryId: string; defaultLanguage?: string; defaultAudioLanguage?: string };
  status: { privacyStatus: Privacy; publishAt?: string; selfDeclaredMadeForKids: boolean; containsSyntheticMedia: boolean; license: 'youtube' | 'creativeCommon'; embeddable: boolean; publicStatsViewable: boolean };
  recordingDetails?: { recordingDate: string };
}
/** Visibilité réellement envoyée : une vidéo programmée est obligatoirement privée. */
export const effectivePrivacy = (d: Pick<VideoDraft, 'privacy' | 'scheduleAt'>): Privacy => (d.scheduleAt ? 'private' : d.privacy);

export function buildVideoResource(d: VideoDraft, description: string): VideoResource {
  const tags = fitTags(normalizeTags(d.tags));
  const res: VideoResource = {
    snippet: {
      title: sanitizeYtText(d.title.trim()).slice(0, TITLE_MAX),
      description,
      categoryId: String(d.categoryId),
      ...(tags.length ? { tags } : {}),
      ...(d.defaultLanguage ? { defaultLanguage: d.defaultLanguage } : {}),
      ...(d.defaultAudioLanguage ? { defaultAudioLanguage: d.defaultAudioLanguage } : {}),
    },
    status: {
      privacyStatus: effectivePrivacy(d),
      ...(d.scheduleAt ? { publishAt: new Date(d.scheduleAt).toISOString() } : {}),
      selfDeclaredMadeForKids: d.madeForKids === true,
      containsSyntheticMedia: d.containsSyntheticMedia,
      license: d.license,
      embeddable: d.embeddable,
      publicStatsViewable: d.publicStatsViewable,
    },
  };
  if (d.recordingDate && /^\d{4}-\d{2}-\d{2}$/.test(d.recordingDate)) res.recordingDetails = { recordingDate: `${d.recordingDate}T00:00:00.000Z` };
  return res;
}
/** Paramètre `part` correspondant (snippet,status[,recordingDetails]). */
export const resourceParts = (r: VideoResource) => ['snippet', 'status', ...(r.recordingDetails ? ['recordingDetails'] : [])].join(',');

// ── Validation ───────────────────────────────────────────────
export interface Issue { level: 'error' | 'warning' | 'info'; field: string; message: string }
export const isShort = (f?: VideoDraft['file']) => !!f?.durationSec && f.durationSec <= 180 && !!f.width && !!f.height && f.height >= f.width;

export function validateDraft(d: VideoDraft, opts: { description?: string; now?: number } = {}): Issue[] {
  const now = opts.now ?? Date.now();
  const out: Issue[] = [];
  const add = (level: Issue['level'], field: string, message: string) => out.push({ level, field, message });
  if (!d.channelId) add('error', 'channel', 'Choisis la chaîne de destination.');
  if (!d.file) add('error', 'file', 'Choisis le fichier vidéo à mettre en ligne.');
  const title = d.title.trim();
  if (!title) add('error', 'title', 'Le titre est obligatoire.');
  else {
    if ([...title].length > TITLE_MAX) add('error', 'title', `Titre trop long : ${[...title].length}/${TITLE_MAX} caractères.`);
    if (/[<>]/.test(title)) add('warning', 'title', 'Les caractères < et > sont interdits par YouTube : ils seront remplacés par ‹ ›.');
    if ([...title].length > 60) add('info', 'title', `Sur mobile, seuls ~${MOBILE_TITLE_VISIBLE} premiers caractères sont visibles : mets l'essentiel au début.`);
  }
  const desc = opts.description ?? d.description;
  const bytes = utf8Bytes(desc);
  if (bytes > DESCRIPTION_MAX_BYTES) add('error', 'description', `Description trop longue : ${bytes}/${DESCRIPTION_MAX_BYTES} octets.`);
  if (/[<>]/.test(d.description.replace(/\{\{[^}]*\}\}/g, ''))) add('warning', 'description', 'Les caractères < et > seront remplacés par ‹ › (interdits par YouTube).');
  const unknown = unknownVariables(d.description);
  if (unknown.length) add('warning', 'description', `Variable(s) inconnue(s) laissée(s) telle(s) quelle(s) : ${unknown.map(k => `{{${k}}}`).join(', ')}.`);
  if (/\[[A-ZÉÈ][A-ZÉÈ ]+\]|\[lien sponsor\]/.test(desc)) add('warning', 'description', 'La description contient encore un champ à compléter entre crochets.');
  const tl = tagsLength(d.tags);
  if (tl > TAGS_MAX) add('error', 'tags', `Tags trop longs : ${tl}/${TAGS_MAX} caractères (les derniers seront retirés).`);
  if (!d.categoryId) add('error', 'category', 'Choisis une catégorie.');
  if (!d.defaultLanguage) add('warning', 'language', 'Indique la langue du titre et de la description.');
  if (!d.defaultAudioLanguage) add('info', 'language', 'Indique la langue audio (améliore les sous-titres automatiques et la recherche).');
  if (d.madeForKids === null) add('error', 'kids', 'Indique si la vidéo est conçue pour les enfants (obligation légale, loi COPPA).');
  if (d.scheduleAt) {
    const t = new Date(d.scheduleAt).getTime();
    if (!Number.isFinite(t)) add('error', 'schedule', 'Date de programmation invalide.');
    else if (t <= now) add('error', 'schedule', 'La date de programmation est passée : la vidéo serait publiée immédiatement.');
    else if (t - now < 15 * 60_000) add('warning', 'schedule', "Programmation très proche : l'envoi risque de ne pas être fini à temps (la vidéo serait alors publiée dès la fin de l'envoi).");
  }
  if (d.includeChapters && d.chapters.length) for (const m of validateChapters(d.chapters, d.file?.durationSec)) add('warning', 'chapters', m);
  if (!d.thumbnail) add(isShort(d.file) ? 'info' : 'warning', 'thumbnail', 'Aucune miniature personnalisée : YouTube choisira une image de la vidéo.');
  else if ((d.thumbnail.size ?? 0) > THUMB_MAX_BYTES) add('info', 'thumbnail', 'Miniature > 2 Mo : elle sera recompressée en JPEG avant l’envoi.');
  for (const c of d.captions) if (!c.language) add('error', 'captions', `Langue manquante pour les sous-titres « ${c.fileName} ».`);
  if (isShort(d.file)) add('info', 'file', 'Format Short détecté (≤ 3 min, vertical) : pas de chapitres, et la miniature n’est appliquée qu’après le traitement.');
  if (d.abTest && d.abTest.variants.length >= 2 && effectivePrivacy(d) !== 'public' && !d.scheduleAt) add('warning', 'abtest', 'Le test A/B ne démarrera que lorsque la vidéo sera publique.');
  return out;
}
export const hasBlocking = (issues: Issue[]) => issues.some(i => i.level === 'error');
