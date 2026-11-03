// Extraction de texte brut depuis le JSON TipTap (recherche, aperçus, rappels). Fonctions pures.
import type { JSONContent } from '@tiptap/core';

const INLINE_TEXT: Record<string, (n: JSONContent) => string> = {
  hardBreak: () => '\n',
  mention: n => '@' + String(n.attrs?.label ?? n.attrs?.id ?? ''),
  inlineMath: n => String(n.attrs?.latex ?? ''),
  filePin: n => String(n.attrs?.name ?? ''),
  image: n => String(n.attrs?.alt ?? ''),
};

/** Texte d'un nœud : enfants blocs séparés par des retours à la ligne. */
export function nodeText(n: JSONContent | undefined | null): string {
  if (!n) return '';
  if (n.type === 'text') return n.text ?? '';
  const special = n.type ? INLINE_TEXT[n.type] : undefined;
  if (special) return special(n);
  if (n.type === 'blockMath') return String(n.attrs?.latex ?? '');
  if (n.type === 'pageBlock') return String(n.attrs?.title ?? '');
  if (n.type === 'fileBlock' || n.type === 'video' || n.type === 'audio') return String(n.attrs?.name ?? '');
  if (n.type === 'embed' || n.type === 'youtube') return String(n.attrs?.src ?? '');
  const kids = n.content ?? [];
  if (!kids.length) return '';
  const inline = kids.every(k => k.type === 'text' || (k.type && k.type in INLINE_TEXT));
  return kids.map(nodeText).join(inline ? '' : '\n');
}

/** Texte complet d'un document. */
export const docToText = (doc: unknown) => nodeText(doc as JSONContent);

/** Texte de chaque bloc de premier niveau (index = position dans le document). */
export function blockTexts(doc: unknown): string[] {
  const d = doc as JSONContent | null;
  return (d?.content ?? []).map(nodeText);
}

/** Nombre de mots d'un texte. */
export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
