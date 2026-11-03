// Relations : calculs purs pour la synchronisation bidirectionnelle.
import { asList } from './engine';

/** Ids ajoutés / retirés entre deux valeurs de relation. */
export function relationDiff(before: unknown, after: unknown): { added: string[]; removed: string[] } {
  const a = asList(before), b = asList(after);
  return { added: b.filter(x => !a.includes(x)), removed: a.filter(x => !b.includes(x)) };
}

/** Nouvelle valeur de la relation miroir d'une ligne cible après ajout/retrait de `rowId`. */
export function mirrorValue(current: unknown, rowId: string, link: boolean): string[] {
  const ids = asList(current).filter(x => x !== rowId);
  return link ? [...ids, rowId] : ids;
}
