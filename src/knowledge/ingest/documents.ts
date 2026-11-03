// Import de documents (texte, Markdown, PDF texte collé) → principes de kind « document » ; principes manuels.
import { isAbortError } from '../../claude/api';
import { uid } from '../../db/store';
import type { Source, Topic } from '../api';
import { engine } from '../engine';
import { runJob } from '../job';
import { classifyTopic, clip } from '../text';
import { extractFromDocumentChunk } from './extract';

/** Nettoyage Markdown léger. */
export const stripMarkdown = (s: string) => s
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
  .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/** Découpe en passages ≤ maxChars en respectant les paragraphes (titres gardés avec leur contenu). */
export function splitDocument(text: string, maxChars = 6000): string[] {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const out: string[] = []; let cur = '';
  for (const p of paras) {
    if (p.length > maxChars) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    if (cur && cur.length + p.length + 2 > maxChars) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

/** Mode « brut » (sans Claude) : chaque puce ou paragraphe devient un principe ; sujet deviné par mots-clés. */
export function rawPrinciplesFromText(text: string): { topic: Topic; title: string; text: string }[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const items: string[] = []; let para: string[] = [];
  const flushPara = () => { if (para.length) { items.push(para.join(' ')); para = []; } };
  for (const l of lines) {
    const t = l.trim();
    if (!t) { flushPara(); continue; }
    if (/^#{1,6}\s/.test(t)) { flushPara(); continue; } // titres de section ignorés
    const bullet = /^(?:[-*•–]|\d+[.)])\s+(.*)$/.exec(t);
    if (bullet) { flushPara(); items.push(bullet[1]); continue; }
    para.push(t);
  }
  flushPara();
  const out: { topic: Topic; title: string; text: string }[] = [];
  for (const raw of items) {
    const body = stripMarkdown(raw).replace(/\s+/g, ' ').trim();
    if (body.length < 25) continue;
    const first = /^(.{12,}?[.!?:])(\s|$)/.exec(body)?.[1] ?? body;
    out.push({ topic: classifyTopic(body), title: clip(first.replace(/[.:]$/, ''), 80), text: clip(body, 600) });
  }
  return out;
}

export interface DocumentInput { title: string; creator: string; text: string; url?: string; mode: 'claude' | 'brut' }

/** Importe un document comme source « document » (extraction par Claude ou découpage brut). */
export function importDocument(input: DocumentInput): Promise<{ added: number; duplicates: number; sourceId: string }> {
  return runJob('import', `Import de « ${input.title} »`, async (h) => {
    await engine.init();
    const title = input.title.trim() || 'Document sans titre';
    const creator = input.creator.trim() || 'Inconnu';
    const text = input.text.trim();
    if (text.length < 40) throw new Error('Le document est vide ou trop court.');
    const sourceId = 'doc:' + uid();
    const src: Source = { kind: 'document', creator, videoTitle: title, ...(input.url?.trim() ? { url: input.url.trim() } : {}) };
    let items: { topic: Topic; title: string; text: string }[] = [];
    if (input.mode === 'brut') {
      h.phase('Découpage du document', 1);
      items = rawPrinciplesFromText(text);
      h.step(1);
    } else {
      const chunks = splitDocument(stripMarkdown(text));
      h.phase('Extraction des principes par Claude', chunks.length);
      for (const [i, c] of chunks.entries()) {
        if (h.signal.aborted) break;
        h.step(i, `Passage ${i + 1}/${chunks.length}`);
        try { items.push(...(await extractFromDocumentChunk({ creator, title }, c, h.signal))); }
        catch (e) { if (isAbortError(e)) break; throw e; }
      }
      h.step(chunks.length);
    }
    h.phase('Dédoublonnage et indexation');
    const res = await engine.addPrinciples(items.map(it => ({ ...it, origin: 'document' as const, sourceId, source: src })));
    const now = Date.now();
    await engine.upsertSource({
      id: sourceId, kind: 'document', creator, title, url: src.url, status: res.added.length ? 'ok' : 'empty',
      detail: input.mode === 'brut' ? 'Découpage brut (sans Claude)' : undefined, principles: res.added.length, attempts: 1, createdAt: now, updatedAt: now,
    });
    h.counts(res.added.length, res.duplicates.length);
    h.log('ok', `${res.added.length} principe(s) importé(s)${res.duplicates.length ? `, ${res.duplicates.length} doublon(s) écarté(s)` : ''}.`);
    return { added: res.added.length, duplicates: res.duplicates.length, sourceId };
  });
}
