// Rédaction : réponses, transferts, citations, conversions HTML ⇄ texte (pur, testé).
import type { ComposeMode, MailAddress } from './types';
import { escapeHtml, formatAddress, longDate, normEmail, normalizeSubject, uniqAddresses } from './util';

export interface QuoteSource {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo?: MailAddress[];
  date: number;
  subject: string;
  messageId?: string;
  references?: string[];
  /** HTML du message d'origine DÉJÀ nettoyé (sanitizeMailHtml). */
  safeHtml?: string;
  text: string;
}

export const replySubject = (s: string) => `Re: ${normalizeSubject(s) || '(sans objet)'}`;
export const forwardSubject = (s: string) => `Fwd: ${normalizeSubject(s) || '(sans objet)'}`;
export function subjectFor(mode: ComposeMode, s: string): string {
  if (mode === 'reply' || mode === 'replyAll') return replySubject(s);
  if (mode === 'forward') return forwardSubject(s);
  return s;
}

/** Destinataires d'une réponse. `mine` = mes adresses (compte + alias). */
export function replyRecipients(src: QuoteSource, mine: string[], mode: 'reply' | 'replyAll'): { to: MailAddress[]; cc: MailAddress[] } {
  const me = mine.map(normEmail);
  const fromMe = me.includes(normEmail(src.from.email));
  // Réponse à mon propre message : on s'adresse aux destinataires d'origine.
  const primary = fromMe ? src.to : (src.replyTo?.length ? src.replyTo : [src.from]);
  if (mode === 'reply') {
    const to = uniqAddresses(primary, fromMe ? me : []);
    return { to: to.length ? to : uniqAddresses(primary), cc: [] };
  }
  const to = uniqAddresses([...primary, ...(fromMe ? [] : src.to)], me);
  const cc = uniqAddresses(src.cc, [...me, ...to.map(a => a.email)]);
  return { to: to.length ? to : uniqAddresses(primary), cc };
}

/** Chaîne References d'une réponse : celles d'origine + son Message-ID (20 max, racine conservée). */
export function buildReferences(src: Pick<QuoteSource, 'references' | 'messageId'>): string[] {
  const ids = [...(src.references ?? []), ...(src.messageId ? [src.messageId] : [])]
    .map(r => r.trim().replace(/^<|>$/g, '')).filter(Boolean);
  const uniq = [...new Set(ids)];
  return uniq.length > 20 ? [uniq[0], ...uniq.slice(-19)] : uniq;
}

export const quoteAttribution = (src: Pick<QuoteSource, 'date' | 'from'>) => `Le ${longDate(src.date)}, ${formatAddress(src.from)} a écrit :`;

const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:2px solid #c7c7cc;padding-left:1ex;color:#3a3a3c';

/** Bloc HTML cité (réponse). */
export function buildReplyQuoteHtml(src: QuoteSource): string {
  const inner = src.safeHtml?.trim() ? src.safeHtml : textToHtml(src.text);
  return `<div class="prisme_quote"><div>${escapeHtml(quoteAttribution(src))}</div><blockquote type="cite" style="${QUOTE_STYLE}">${inner}</blockquote></div>`;
}

/** En-tête « Message transféré » + contenu d'origine. */
export function buildForwardHtml(src: QuoteSource): string {
  const rows: [string, string][] = [
    ['De', formatAddress(src.from)],
    ['Date', longDate(src.date)],
    ['Objet', src.subject || '(sans objet)'],
    ['À', src.to.map(formatAddress).join(', ')],
  ];
  if (src.cc.length) rows.push(['Cc', src.cc.map(formatAddress).join(', ')]);
  const head = rows.map(([k, v]) => `${k} : ${escapeHtml(v)}`).join('<br>');
  const inner = src.safeHtml?.trim() ? src.safeHtml : textToHtml(src.text);
  return `<div class="prisme_forward"><div>---------- Message transféré ----------<br>${head}</div><br>${inner}</div>`;
}

export function quoteText(src: QuoteSource): string {
  const body = (src.text || '').replace(/\r\n/g, '\n').trimEnd().split('\n').map(l => (l.startsWith('>') ? '>' + l : '> ' + l)).join('\n');
  return `${quoteAttribution(src)}\n${body}`;
}
export function forwardText(src: QuoteSource): string {
  const lines = [
    '---------- Message transféré ----------',
    `De : ${formatAddress(src.from)}`,
    `Date : ${longDate(src.date)}`,
    `Objet : ${src.subject || '(sans objet)'}`,
    `À : ${src.to.map(formatAddress).join(', ')}`,
    ...(src.cc.length ? [`Cc : ${src.cc.map(formatAddress).join(', ')}`] : []),
    '',
    src.text || '',
  ];
  return lines.join('\n');
}

/** HTML final envoyé : corps de l'éditeur (+ signature) puis citation éventuelle. */
export function composeHtml(bodyHtml: string, quoteHtml?: string): string {
  const quote = quoteHtml ? `<br>${quoteHtml}` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div dir="auto" style="font-family:-apple-system,'Segoe UI',Inter,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">${bodyHtml}${quote}</div></body></html>`;
}
export function composeText(bodyText: string, quote?: string): string {
  return quote ? `${bodyText.trimEnd()}\n\n${quote}` : bodyText;
}

// ── Conversions ───────────────────────────────────────────────
const URL_RE = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Texte brut → HTML (paragraphes, retours à la ligne, liens cliquables). */
export function textToHtml(text: string): string {
  const paras = (text ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return paras
    .map(p => p.trim() ? `<p>${escapeHtml(p).replace(URL_RE, u => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>')}</p>` : '')
    .filter(Boolean).join('');
}

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'PRE', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'CENTER', 'DL', 'DT', 'DD', 'FORM', 'FIELDSET']);
const SKIP = new Set(['STYLE', 'SCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

/** HTML → texte lisible (liens « texte (url) », listes, citations « > »). */
export function htmlToText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const nl = () => { if (out.length && !out[out.length - 1].endsWith('\n')) out.push('\n'); };
  const walk = (n: Node, pre: boolean, listIdx: { n: number } | null) => {
    if (n.nodeType === 3) {
      const t = n.textContent ?? '';
      out.push(pre ? t : t.replace(/[ \t\r\n\f]+/g, ' '));
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element; const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (tag === 'BR') { out.push('\n'); return; }
    if (tag === 'HR') { nl(); out.push('———\n'); return; }
    if (tag === 'IMG') { const alt = el.getAttribute('alt')?.trim(); if (alt) out.push(`[${alt}]`); return; }
    if (tag === 'BLOCKQUOTE') {
      nl();
      const inner = htmlToText(el.innerHTML).split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
      out.push(inner + '\n');
      return;
    }
    const block = BLOCK.has(tag);
    if (block) nl();
    if (tag === 'LI') out.push(listIdx ? `${++listIdx.n}. ` : '- ');
    if (tag === 'TD' || tag === 'TH') { if (el.previousElementSibling) out.push(' '); }
    const childList = tag === 'OL' ? { n: 0 } : tag === 'UL' ? null : listIdx;
    el.childNodes.forEach(c => walk(c, pre || tag === 'PRE', childList));
    if (tag === 'A') {
      const href = el.getAttribute('href') ?? '';
      const label = (el.textContent ?? '').trim();
      if (/^https?:/i.test(href) && href !== label && !label.includes(href)) out.push(` (${href})`);
    }
    if (block) nl();
    if (tag === 'P' || /^H[1-6]$/.test(tag)) out.push('\n');
  };
  walk(doc.body, false, null);
  return out.join('')
    .split('\n').map(l => l.replace(/[  ]+$/g, '').replace(/^[  ]+(?=\S)/, m => (m.length > 3 ? '' : m))).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ATTRIBUTION = [
  /^(le|on)\b.{4,220}\b(a écrit|wrote|schrieb|escribió|ha scritto)\s*:?\s*$/i,
  /^-{2,}\s*(original message|message d'origine|message transféré|forwarded message|ursprüngliche nachricht)/i,
  /^_{8,}\s*$/,
];
const HEADER_BLOCK = /^(de|from)\s*:\s*.+/i;
const HEADER_NEXT = /^(envoyé|sent|date|à|to|objet|subject)\s*:/i;

/** Retire les citations / historiques (« Le … a écrit : », « > », en-têtes Outlook) d'un texte. */
export function stripQuotedText(text: string): string {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const joined = (l + ' ' + (lines[i + 1] ?? '').trim()).trim();
    if (ATTRIBUTION.some(r => r.test(l)) || (/^(le|on)\b/i.test(l) && ATTRIBUTION[0].test(joined))) { cut = i; break; }
    if (HEADER_BLOCK.test(l) && HEADER_NEXT.test((lines[i + 1] ?? '').trim())) { cut = i; break; }
    if (l.startsWith('>')) {
      // bloc cité final (ou majoritaire en fin de message)
      const rest = lines.slice(i).filter(x => x.trim());
      if (rest.every(x => x.trim().startsWith('>'))) { cut = i; break; }
    }
  }
  return lines.slice(0, cut).filter(l => !l.trim().startsWith('>')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Texte de Claude (brut, paragraphes) → HTML pour l'éditeur. */
export function plainDraftToHtml(text: string): string {
  const cleaned = (text ?? '').replace(/\r\n/g, '\n').replace(/^```[a-z]*\n?|```$/gim, '').trim();
  return cleaned.split(/\n{2,}/).map(p => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}
