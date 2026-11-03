// ─────────────────────────────────────────────────────────────
// CONTRAT Base de connaissances — implémenté par le module knowledge.
// Les assistants appellent searchPrinciples() et citent formatCitation().
// ─────────────────────────────────────────────────────────────
export type Topic = 'script' | 'retention' | 'hook' | 'thumbnail' | 'title' | 'packaging' | 'analytics' | 'general';
export interface Source { creator: string; videoId?: string; videoTitle?: string; url?: string; timestamp?: number /* secondes */; kind: 'youtube' | 'document' | 'ab-test' | 'manual' }
export interface Principle { id: string; topic: Topic; title: string; text: string; source: Source; score?: number }

type Impl = {
  search: (query: string, opts?: { topic?: Topic; k?: number }) => Promise<Principle[]>;
  add: (p: Omit<Principle, 'id'>) => Promise<Principle>;
};
let impl: Impl = { search: async () => [], add: async (p) => ({ ...p, id: crypto.randomUUID() }) };
export const setKnowledgeImpl = (i: Impl) => { impl = i; };

export const searchPrinciples = (query: string, opts?: { topic?: Topic; k?: number }) => impl.search(query, opts);
export const addPrinciple = (p: Omit<Principle, 'id'>) => impl.add(p);

export const fmtTime = (s?: number) => s == null ? '' : `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
/** « Principe : hook en < 5 s — source : Paddy Galloway, 03:42 » */
export const formatCitation = (p: Principle) =>
  `Principe : ${p.title} — source : ${p.source.creator}${p.source.timestamp != null ? ', ' + fmtTime(p.source.timestamp) : ''}`;
/** Bloc de contexte à injecter dans un prompt système (principes numérotés, à citer par [n]). */
export const principlesToPrompt = (ps: Principle[]) =>
  ps.map((p, i) => `[${i + 1}] ${p.title} : ${p.text} (source : ${p.source.creator}${p.source.timestamp != null ? ', ' + fmtTime(p.source.timestamp) : ''})`).join('\n');
