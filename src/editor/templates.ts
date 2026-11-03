// Templates de pages : modèles intégrés + modèles de l'utilisateur (kv 'templates').
import type { Editor, JSONContent } from '@tiptap/core';
import { addDays, format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { repo, uid } from '../db/store';
import { createPage } from '../db/pages';
import type { Page } from '../db/types';
import { createDatabase } from '../database/api';
import { openPage, toast } from '../ui/appState';
import { callout, cloneDoc, cols, dateMention, doc, h, hr, ol, p, quote, table, todo, toggle, ul, txt } from './blocks';

export interface PageTemplate {
  id: string; name: string; icon: string; description: string; category: string;
  title?: string; cover?: string; builtin: boolean;
  build: () => JSONContent;
  /** Template de base de données (crée une base au lieu d'une page). */
  database?: () => Promise<string>;
}
interface StoredTemplate { id: string; name: string; icon: string; description?: string; title: string; cover?: string; content: JSONContent; createdAt: number }

const today = () => new Date();
const dayLabel = () => format(today(), 'EEEE d MMMM yyyy', { locale: fr });

export const BUILTIN_TEMPLATES: PageTemplate[] = [
  {
    id: 'meeting', name: 'Note de réunion', icon: '🤝', category: 'Travail', builtin: true, cover: 'gradient:2',
    description: 'Ordre du jour, notes, décisions et actions à suivre.',
    title: 'Réunion — ',
    build: () => doc(
      { type: 'paragraph', content: [txt('📅 Date : ', ['bold']), dateMention(today()), txt('   👥 Participants : ', ['bold']), txt('@…')] },
      callout('🎯', 'blue', '**Objectif de la réunion :** '),
      h(2, 'Ordre du jour'), ol('', '', ''),
      h(2, 'Notes'), p(),
      h(2, 'Décisions'), ul(''),
      h(2, 'Actions'), todo('Action — responsable — échéance', 'Envoyer le compte rendu'),
      toggle('Ressources et liens', ''),
    ),
  },
  {
    id: 'journal', name: 'Journal', icon: '📔', category: 'Personnel', builtin: true, cover: 'gradient:5',
    description: 'Une page par jour : humeur, gratitude, objectifs et bilan.',
    title: `Journal — ${format(today(), 'd MMMM yyyy', { locale: fr })}`,
    build: () => doc(
      p(`*${dayLabel()}*`),
      cols([h(3, '☀️ Humeur'), p('😀 😐 😔 — entoure ton humeur')], [h(3, '⚡ Énergie'), p('▢▢▢▢▢')]),
      h(2, '🙏 Gratitude'), ol('', '', ''),
      h(2, '🎯 Objectifs du jour'), todo('', '', ''),
      h(2, '📝 Notes'), p(),
      h(2, '🌙 Bilan du soir'),
      toggle('Ce qui s’est bien passé', ''), toggle('Ce que j’améliorerais', ''),
    ),
  },
  {
    id: 'video-brief', name: 'Brief vidéo', icon: '🎬', category: 'YouTube', builtin: true, cover: 'gradient:0',
    description: 'Concept, cible, hook, structure, titres, miniature et checklist de tournage.',
    title: 'Brief — ',
    build: () => doc(
      callout('💡', 'yellow', '**Concept en une phrase :** '),
      table([['', ''], ['Cible', ''], ['Durée visée', ''], ['Format', 'Vidéo longue / Short'], ['Date de publication', '']], false),
      h(2, '🪝 Hook (0-30 s)'), quote('Ce que le spectateur voit et entend dans les 5 premières secondes…'),
      h(2, '🤝 Promesse'), p('Pourquoi rester jusqu’à la fin ?'),
      h(2, '🧱 Structure'),
      toggle('1. Intrigue / boucles ouvertes', ''), toggle('2. Corps — montée de tension', ''), toggle('3. Re-hooks réguliers', ''), toggle('4. Payoff', ''), toggle('5. Appel à l’action', ''),
      h(2, '🏷️ Idées de titres'), ul('', '', ''),
      h(2, '🖼️ Miniature'), cols([p('**Élément principal :** ')], [p('**Texte (≤ 3 mots) :** ')]),
      h(2, '🎥 Checklist de tournage'), todo('Script finalisé', 'Plans B-roll listés', 'Lumière et son testés', 'Rushs sauvegardés'),
      h(2, '🔗 Références'), p(),
    ),
  },
  {
    id: 'project-plan', name: 'Plan de projet', icon: '🗺️', category: 'Travail', builtin: true, cover: 'gradient:3',
    description: 'Objectifs, jalons, tâches, risques et ressources.',
    title: 'Projet — ',
    build: () => doc(
      callout('🎯', 'purple', '**Objectif :** ce que le projet doit accomplir, et comment on saura qu’il est réussi.'),
      h(2, 'Contexte'), p(),
      h(2, 'Jalons'),
      table([['Jalon', 'Échéance', 'Responsable', 'Statut'], ['Cadrage', format(addDays(today(), 7), 'dd/MM/yyyy'), '', 'À faire'], ['Production', format(addDays(today(), 21), 'dd/MM/yyyy'), '', 'À faire'], ['Livraison', format(addDays(today(), 35), 'dd/MM/yyyy'), '', 'À faire']]),
      h(2, 'Tâches'), todo('', '', ''),
      h(2, 'Risques'), ul('Risque — impact — parade'),
      h(2, 'Ressources'), ul('Budget : ', 'Outils : ', 'Personnes : '),
      hr(), p('*Dernière mise à jour :* '),
    ),
  },
  {
    id: 'wiki', name: 'Wiki', icon: '📚', category: 'Connaissances', builtin: true, cover: 'gradient:4',
    description: 'Base de connaissances avec sommaire, sections et FAQ.',
    title: 'Wiki — ',
    build: () => doc(
      callout('📌', 'gray', 'À quoi sert ce wiki et à qui il s’adresse.'),
      h(2, 'Sommaire'), ul('Prise en main', 'Processus', 'Ressources', 'FAQ'),
      h(2, 'Prise en main'), p(),
      h(2, 'Processus'), ol('', ''),
      h(2, 'Ressources'), ul(''),
      h(2, 'FAQ'), toggle('Question fréquente n° 1', 'Réponse…'), toggle('Question fréquente n° 2', 'Réponse…'),
    ),
  },
  {
    id: 'week', name: 'Planning de la semaine', icon: '🗓️', category: 'Personnel', builtin: true, cover: 'gradient:1',
    description: 'Priorités, jours de la semaine et bilan.',
    title: `Semaine du ${format(today(), 'd MMMM', { locale: fr })}`,
    build: () => doc(
      h(2, '🎯 Trois priorités'), todo('', '', ''),
      cols([h(3, 'Lundi'), todo(''), h(3, 'Mardi'), todo(''), h(3, 'Mercredi'), todo('')], [h(3, 'Jeudi'), todo(''), h(3, 'Vendredi'), todo(''), h(3, 'Week-end'), todo('')]),
      h(2, '📈 Bilan'), toggle('Victoires', ''), toggle('Leçons', ''),
    ),
  },
  {
    id: 'publish-checklist', name: 'Checklist de publication', icon: '🚀', category: 'YouTube', builtin: true, cover: 'gradient:6',
    description: 'Tout vérifier avant de mettre une vidéo en ligne.',
    title: 'Publication — ',
    build: () => doc(
      callout('✅', 'green', 'Coche chaque étape avant de publier. Rien ne part sans confirmation.'),
      h(2, 'Vidéo'), todo('Export final vérifié (son, sous-titres)', 'Écran de fin et fiches prévus', 'Chapitres rédigés'),
      h(2, 'Packaging'), todo('Titre court (≤ 50 caractères visibles)', 'Miniature lisible en petit', 'Titre et miniature se complètent'),
      h(2, 'Métadonnées'), todo('Description + liens', 'Tags', 'Playlist', 'Visibilité et date de programmation'),
      h(2, 'Après publication'), todo('Partager sur Discord', 'Répondre aux premiers commentaires', 'Vérifier le CTR à 24 h'),
    ),
  },
  {
    id: 'content-calendar', name: 'Calendrier éditorial', icon: '🗃️', category: 'Bases de données', builtin: true,
    description: 'Base de données des vidéos : statut, date de publication, plateforme.',
    build: () => doc(),
    database: () => createDatabase({
      title: 'Calendrier éditorial', icon: '🗃️',
      properties: [
        { name: 'Titre', type: 'title' },
        { name: 'Statut', type: 'status', options: ['Idée', 'Script', 'Tournage', 'Montage', 'Publié'].map((name, i) => ({ id: '', name, color: ['gray', 'blue', 'orange', 'purple', 'green'][i] })) },
        { name: 'Publication', type: 'date' },
        { name: 'Plateforme', type: 'multi_select', options: ['YouTube', 'Shorts', 'TikTok', 'Instagram'].map((name, i) => ({ id: '', name, color: ['red', 'pink', 'gray', 'purple'][i] })) },
        { name: 'Lien', type: 'url' },
      ],
      views: [
        { id: 'board', name: 'Tableau kanban', type: 'board', filters: [], sorts: [], groupBy: '' },
        { id: 'table', name: 'Tableau', type: 'table', filters: [], sorts: [] },
        { id: 'cal', name: 'Calendrier', type: 'calendar', filters: [], sorts: [] },
      ],
    }),
  },
];

export async function userTemplates(): Promise<PageTemplate[]> {
  const list = (await repo.kvGet<StoredTemplate[]>('templates')) ?? [];
  return list.sort((a, b) => b.createdAt - a.createdAt).map(t => ({
    id: t.id, name: t.name, icon: t.icon || '📄', description: t.description ?? 'Modèle personnel', category: 'Mes modèles',
    title: t.title, cover: t.cover, builtin: false, build: () => cloneDoc(t.content),
  }));
}

export async function saveAsTemplate(page: Page, name: string): Promise<void> {
  const list = (await repo.kvGet<StoredTemplate[]>('templates')) ?? [];
  const t: StoredTemplate = { id: uid(), name: name.trim() || page.title || 'Modèle', icon: page.icon ?? '📄', title: page.title, cover: page.cover, content: cloneDoc(page.content as JSONContent), createdAt: Date.now() };
  await repo.kvSet('templates', [t, ...list]);
  toast(`Modèle « ${t.name} » enregistré`, 'success');
}

export async function deleteTemplate(id: string) {
  const list = (await repo.kvGet<StoredTemplate[]>('templates')) ?? [];
  await repo.kvSet('templates', list.filter(t => t.id !== id));
}

/** Crée une page (ou une base) depuis un template et l'ouvre. */
export async function createFromTemplate(t: PageTemplate, parentId: string | null = null): Promise<string> {
  if (t.database) {
    const id = await t.database();
    // une base créée depuis un template est rangée sous le parent demandé
    if (parentId) { const { updatePage } = await import('../db/pages'); await updatePage(id, { parentId }); }
    openPage(id);
    return id;
  }
  const page = await createPage({ title: t.title ?? '', icon: t.icon, cover: t.cover, content: t.build(), parentId });
  openPage(page.id);
  return page.id;
}

/** Insère le contenu d'un template à la position du curseur. */
export function insertTemplate(editor: Editor, t: PageTemplate) {
  const content = t.build().content ?? [];
  editor.chain().focus().insertContent(content).run();
}
