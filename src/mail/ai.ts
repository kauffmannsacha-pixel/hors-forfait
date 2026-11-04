// Claude pour les mails : résumé de fil, brouillon dans MON ton, tri (modèle rapide, par lots),
// extraction sponsor / tâche. Rien n'est jamais envoyé : Claude ne fait que préparer du texte.
import { askClaude, askClaudeJSON } from '../claude/api';
import type { MailBody, MailCategory, MailHeader, MailThread, StyleProfile, TriageResult } from './types';
import { buildTriagePrompt, parseTriageResponse, TRIAGE_SYSTEM, type TriageItem } from './categories';
import { htmlToText, stripQuotedText } from './compose';
import { clip, formatAddress, longDate } from './util';

const today = () => new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Texte utile d'un message (sans l'historique cité). */
export function messageText(h: MailHeader, body?: MailBody, max = 6000): string {
  const raw = body ? (body.text?.trim() ? body.text : htmlToText(body.html ?? '')) : h.snippet;
  const stripped = stripQuotedText(raw);
  return clip((stripped || raw || '').trim(), max);
}

function threadTranscript(thread: MailThread, texts: Record<string, string>, maxMsgs = 12, per = 2500): string {
  return thread.messages.slice(-maxMsgs).map(m =>
    `— De : ${formatAddress(m.from)} · ${longDate(m.date)}${m.to.length ? `\nÀ : ${m.to.map(formatAddress).join(', ')}` : ''}\n${clip(texts[m.key] ?? m.snippet, per)}`,
  ).join('\n\n');
}

export async function summarizeThread(thread: MailThread, texts: Record<string, string>, onText?: (full: string) => void, signal?: AbortSignal): Promise<string> {
  return askClaude({
    system: `Tu résumes des fils d'e-mails pour un créateur YouTube francophone. Nous sommes le ${today()}. Réponds en français, sans préambule, en Markdown léger :
1 phrase de synthèse ; puis 2 à 5 puces (demandes, montants, dates, décisions, pièces jointes importantes) ; puis une ligne « À faire : … » si une action est attendue de ma part. Ne invente rien.`,
    prompt: `Objet : ${thread.subject}\n\n${threadTranscript(thread, texts)}`,
    maxTokens: 700,
    onText: onText ? (_d, full) => onText(full) : undefined,
    signal,
  });
}

/** Apprend mon style d'écriture à partir de mails envoyés (résultat mis en cache par le store). */
export async function learnStyle(samples: string[], myName: string): Promise<StyleProfile> {
  const cleaned = samples.map(s => clip(stripQuotedText(s), 1200)).filter(s => s.length > 40).slice(0, 15);
  if (cleaned.length < 2) throw new Error("Pas assez de mails envoyés pour apprendre ton style (il en faut au moins 2 avec du texte).");
  const r = await askClaudeJSON<{ resume?: string; salutation?: string; formule_finale?: string; registre?: string; exemples?: string[] }>({
    system: "Tu analyses le style d'écriture d'une personne à partir de ses e-mails envoyés, pour pouvoir l'imiter fidèlement.",
    prompt: `Voici ${cleaned.length} e-mails écrits par ${myName} :\n\n${cleaned.map((s, i) => `### Mail ${i + 1}\n${s}`).join('\n\n')}\n\nDécris son style en JSON :
{"resume":"ton, longueur typique, structure, tics de langage, emojis, ponctuation (3-4 phrases)","salutation":"formule d'ouverture habituelle","formule_finale":"formule de fin habituelle (sans la signature)","registre":"tutoiement/vouvoiement et niveau de formalité","exemples":["2 ou 3 extraits courts et représentatifs, recopiés tels quels"]}`,
    maxTokens: 1200,
  });
  return {
    summary: r.resume?.trim() || 'Ton direct et cordial.',
    greeting: r.salutation?.trim() || 'Bonjour,',
    signOff: r.formule_finale?.trim() || 'Bonne journée,',
    formality: r.registre?.trim() || 'Adapté à l’interlocuteur.',
    examples: (r.exemples ?? []).filter(x => typeof x === 'string').map(x => clip(x, 500)).slice(0, 3),
    sampleCount: cleaned.length,
    at: Date.now(),
  };
}

export interface DraftRequest {
  thread: MailThread;
  texts: Record<string, string>;
  myName: string;
  myEmail: string;
  style?: StyleProfile;
  toneNotes?: string;
  intent?: string;
  mode: 'reply' | 'forward' | 'new';
  onText?: (full: string) => void;
  signal?: AbortSignal;
}

/** Brouillon dans mon ton — renvoie du texte brut (paragraphes), inséré dans l'éditeur, jamais envoyé. */
export async function draftReply(o: DraftRequest): Promise<string> {
  const st = o.style;
  const style = st
    ? `Son style (appris de ${st.sampleCount} mails envoyés) : ${st.summary}\nOuverture habituelle : « ${st.greeting} ». Fin habituelle : « ${st.signOff} ». Registre : ${st.formality}.${st.examples.length ? `\nExtraits de ses mails :\n${st.examples.map(e => `« ${e} »`).join('\n')}` : ''}`
    : 'Style : cordial, direct, phrases courtes.';
  const system = `Tu rédiges des brouillons d'e-mails à la place de ${o.myName} <${o.myEmail}>, créateur YouTube francophone. Nous sommes le ${today()}.
Imite fidèlement son ton. ${style}${o.toneNotes?.trim() ? `\nConsignes personnelles : ${o.toneNotes.trim()}` : ''}
Règles : écris UNIQUEMENT le corps du mail, en texte brut (paragraphes séparés par une ligne vide), sans objet, sans Markdown et SANS signature (elle est ajoutée automatiquement). N'invente aucun montant, date, disponibilité ou engagement absent du fil : mets un repère entre crochets, ex. [tarif à préciser]. Ce texte est un brouillon que ${o.myName} relira et enverra lui-même.`;
  const ask = o.mode === 'forward'
    ? `Rédige un court message d'accompagnement pour transférer ce fil.${o.intent ? ` Intention : ${o.intent}` : ''}`
    : o.intent?.trim() ? `Rédige la réponse au dernier message. Intention : ${o.intent.trim()}` : 'Rédige la réponse la plus appropriée au dernier message du fil.';
  const txt = await askClaude({
    system,
    prompt: `Objet : ${o.thread.subject}\n\nFil (du plus ancien au plus récent) :\n\n${threadTranscript(o.thread, o.texts, 8, 3000)}\n\n${ask}`,
    maxTokens: 1500,
    onText: o.onText ? (_d, full) => o.onText!(full) : undefined,
    signal: o.signal,
  });
  return txt.replace(/^\s*(objet|subject)\s*:.*\n+/i, '').trim();
}

/** Tri d'un lot (≤ 20) avec le modèle rapide. Clés d'entrée → résultats. */
export async function triageBatch(headers: MailHeader[], cats: MailCategory[]): Promise<Map<MailHeader, TriageResult>> {
  const items: TriageItem[] = headers.map((h, i) => ({
    id: String(i + 1),
    from: h.from.name ? `${h.from.name} <${h.from.email}>` : h.from.email,
    subject: clip(h.subject || '(sans objet)', 160),
    snippet: clip(h.snippet || '', 280),
    date: new Date(h.date || Date.now()).toISOString().slice(0, 16).replace('T', ' '),
  }));
  const raw = await askClaude({
    fast: true,
    system: `${TRIAGE_SYSTEM}\nNous sommes le ${today()}. Réponds UNIQUEMENT avec du JSON valide.`,
    prompt: buildTriagePrompt(items, cats),
    maxTokens: 120 + headers.length * 60,
  });
  const parsed = parseTriageResponse(raw, cats, items.map(i => i.id));
  const out = new Map<MailHeader, TriageResult>();
  headers.forEach((h, i) => { const r = parsed[String(i + 1)]; if (r) out.set(h, r); });
  return out;
}

export interface SponsorInfo { marque: string; contact: string; montant: number | null; date_limite: string | null; livrables: string; resume: string }

export async function extractSponsor(h: MailHeader, text: string): Promise<SponsorInfo> {
  const r = await askClaudeJSON<Partial<SponsorInfo>>({
    system: `Tu extrais les informations d'une proposition de partenariat (sponsor) reçue par e-mail par un créateur YouTube. Nous sommes le ${today()}. N'invente rien : null si absent.`,
    prompt: `De : ${formatAddress(h.from)}\nObjet : ${h.subject}\nReçu le : ${longDate(h.date)}\n\n${clip(text, 6000)}\n\nJSON attendu :
{"marque":"nom de la marque ou de l'entreprise","contact":"adresse e-mail du contact (sinon celle de l'expéditeur)","montant":nombre en euros ou null,"date_limite":"AAAA-MM-JJ ou null (échéance pour répondre ou pour la publication)","livrables":"ce qui est demandé (format, nombre de vidéos…)","resume":"2 phrases"}`,
    maxTokens: 600,
  });
  const montant = typeof r.montant === 'number' ? r.montant : typeof r.montant === 'string' ? parseFloat(String(r.montant).replace(/[^\d,.]/g, '').replace(',', '.')) || null : null;
  const date = typeof r.date_limite === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date_limite) ? r.date_limite : null;
  return {
    marque: (r.marque || h.from.name || h.from.email.split('@')[1]?.split('.')[0] || 'Marque').toString().trim(),
    contact: (r.contact && String(r.contact).includes('@') ? String(r.contact) : h.from.email).trim(),
    montant, date_limite: date,
    livrables: (r.livrables ?? '').toString().trim(),
    resume: (r.resume ?? '').toString().trim(),
  };
}

export interface TaskInfo { titre: string; echeance: string | null; priorite: 'Haute' | 'Moyenne' | 'Basse'; details: string }

export async function extractTask(h: MailHeader, text: string): Promise<TaskInfo> {
  const r = await askClaudeJSON<Partial<TaskInfo>>({
    fast: true,
    system: `Tu transformes un e-mail en tâche actionnable pour un créateur YouTube. Nous sommes le ${today()}.`,
    prompt: `De : ${formatAddress(h.from)}\nObjet : ${h.subject}\n\n${clip(text, 4000)}\n\nJSON : {"titre":"verbe d'action + objet, 8 mots max","echeance":"AAAA-MM-JJ ou null","priorite":"Haute|Moyenne|Basse","details":"1-2 phrases"}`,
    maxTokens: 300,
  });
  const p = String(r.priorite ?? '').toLowerCase();
  return {
    titre: (r.titre || `Répondre à ${h.from.name || h.from.email}`).toString().trim(),
    echeance: typeof r.echeance === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.echeance) ? r.echeance : null,
    priorite: p.startsWith('h') ? 'Haute' : p.startsWith('b') ? 'Basse' : 'Moyenne',
    details: (r.details ?? '').toString().trim(),
  };
}
