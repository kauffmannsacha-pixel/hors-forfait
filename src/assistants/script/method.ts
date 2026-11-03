// La méthode de scripting de l'utilisateur (skill « youtube-scripting-expert », méthode Squiduu / MrBeast)
// encodée en données : sections guidées, styles, techniques. Le texte intégral sert de prompt système.
import methodeRaw from '../../../docs/methode-scripting.md?raw';
import type { Topic } from '../../knowledge/api';

/** Texte intégral de la méthode (docs/methode-scripting.md) — cœur de tous les prompts Claude. */
export const METHODE: string = methodeRaw;

export type SectionKind = 'hook' | 'promesse' | 'intrigue' | 'corps' | 'rehook' | 'payoff' | 'cta' | 'libre' | 'notes';

export interface SectionDef {
  kind: Exclude<SectionKind, 'libre' | 'notes'>;
  heading: string;          // titre H2 inséré dans le script
  label: string;            // libellé court (plan, chips)
  color: string;
  share: number;            // part de la durée cible
  min?: number; max?: number; // bornes en secondes
  guidance: string;         // rappel de la méthode (placeholder + plan)
}

/** Structure guidée : Hook → Promesse → Intrigue → Corps → Re-hooks → Payoff → CTA. */
export const SECTION_DEFS: SectionDef[] = [
  { kind: 'hook', heading: 'Hook (0-30 s)', label: 'Hook', color: '#ff375f', share: 0.04, min: 3, max: 30,
    guidance: 'Première phrase < 5 s qui confirme la miniature. Pas de « salut à tous ». Problème + prétexte, cold open sur la meilleure réaction, quiz ou constat choc + inversion.' },
  { kind: 'promesse', heading: 'Promesse / objectif', label: 'Promesse', color: '#ff9f0a', share: 0.06, min: 3, max: 45,
    guidance: 'Objectif + enjeux chiffrés + plan annoncé avant 30 s. Ce qu\'on ne sait pas encore (« sans me faire cramer… si possible »).' },
  { kind: 'intrigue', heading: 'Intrigue / boucles ouvertes', label: 'Intrigue', color: '#bf5af2', share: 0.08, min: 3,
    guidance: 'Teaser des meilleurs moments, boucles annoncées à voix haute : « plus tard dans cette vidéo… », « retenez bien ça, on va y revenir ».' },
  { kind: 'corps', heading: 'Corps — montée de tension', label: 'Corps', color: '#0a84ff', share: 0.55,
    guidance: 'Paliers d\'escalade (petit → gros), obstacles réels = mini-boucles avec leur solution, fils parallèles. Jamais deux paliers d\'intensité égale d\'affilée.' },
  { kind: 'rehook', heading: 'Re-hooks réguliers', label: 'Re-hooks', color: '#64d2ff', share: 0.12,
    guidance: 'Toutes les 30-40 s : question, teaser, rebondissement, élément planté révélé, pattern interrupt. À mi-vidéo : nouvelle arme / révélation.' },
  { kind: 'payoff', heading: 'Payoff', label: 'Payoff', color: '#30d158', share: 0.12, min: 3,
    guidance: 'La promesse du titre est tenue, de la façon la plus satisfaisante possible. Ne jamais mentir ni décevoir. Un dernier moment qui fait réagir.' },
  { kind: 'cta', heading: 'CTA / sortie sèche', label: 'CTA', color: '#8e8e93', share: 0.03, min: 2, max: 15,
    guidance: '< 15 s, aucun récap : « Si vous avez aimé cette vidéo, vous allez adorer celle-ci. Abonnez-vous parce que la vidéo est terminée. »' },
];
export const sectionDef = (k: SectionKind) => SECTION_DEFS.find(d => d.kind === k);

/** Devine le type de section à partir du titre (H1/H2) écrit par l'utilisateur ou par Claude. */
export function sectionKindOf(title: string): SectionKind {
  const t = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/re-?\s?hook|relance/.test(t)) return 'rehook';
  if (/\bhook\b|accroche|cold open/.test(t)) return 'hook';
  if (/recap des boucles|^notes?\b|sources?|references?|brief|a retenir|checklist/.test(t)) return 'notes';
  if (/promesse|objectif|enjeu|\bplan\b|foreshadow/.test(t)) return 'promesse';
  if (/intrigue|boucle|teaser|sommaire/.test(t)) return 'intrigue';
  if (/payoff|recompense|revelation|apogee|climax|denouement/.test(t)) return 'payoff';
  if (/\bcta\b|outro|sortie|abonne|conclusion/.test(t)) return 'cta';
  if (/corps|tension|palier|histoire|developpement|escalade|obstacle|test|etape/.test(t)) return 'corps';
  return 'libre';
}

export type ScriptStyle = 'roblox' | 'gaming' | 'vlog' | 'educatif' | 'experience' | 'liste' | 'short';
export interface StyleDef { id: ScriptStyle; label: string; icon: string; durations: number[]; defaultSec: number; structure: string; tip: string }
export const STYLES: StyleDef[] = [
  { id: 'roblox', label: 'Roblox', icon: '🧱', durations: [480, 600, 720, 900], defaultSec: 600, structure: 'Expérience / prank (paliers en jeu)',
    tip: 'Défi, troll ou prank en jeu : paliers clairs (niveaux, Robux, joueurs), réactions des joueurs en cold open, obstacles du jeu comme mini-boucles.' },
  { id: 'gaming', label: 'Gaming', icon: '🎮', durations: [480, 600, 720, 900, 1200], defaultSec: 720, structure: 'Expérience / prank',
    tip: 'Problème + prétexte (« je suis nul à Minecraft… donc je me venge »), plan infaillible annoncé, échecs écrits, grand test public à ~75 %.' },
  { id: 'vlog', label: 'Vlog', icon: '📹', durations: [480, 600, 720, 900], defaultSec: 600, structure: 'Story vlog',
    tip: 'Rappel du contexte → calme apparent → coup de théâtre → « je vous raconte toute l\'histoire » → rebondissements → happy end.' },
  { id: 'educatif', label: 'Éducatif', icon: '🎓', durations: [360, 480, 600, 900], defaultSec: 600, structure: 'Question → enquête → réponse',
    tip: 'Hook paradoxal, question centrale tenue jusqu\'au payoff, chaque notion technique expliquée en une phrase simple et drôle.' },
  { id: 'experience', label: 'Expérience / prank', icon: '🧪', durations: [720, 900, 1080, 1200], defaultSec: 900, structure: 'Expérience / prank (12-20 min)',
    tip: '0:00-0:10 hook, 0:10-1:00 plan + enjeux + 1er obstacle, ~35 % test sur un proche, ~50 % re-hook, ~75 % grand test public, fin < 15 s.' },
  { id: 'liste', label: 'Liste / compilation', icon: '📋', durations: [480, 600, 720, 900], defaultSec: 600, structure: 'Liste / compilation',
    tip: 'Teaser des meilleurs items dès l\'intro, commencer par le plus petit, fils parallèles, le plus gros item à la fin.' },
  { id: 'short', label: 'Short', icon: '⚡', durations: [20, 30, 45, 60], defaultSec: 45, structure: 'Short (< 60 s)',
    tip: 'Hook (1 s) → objectif (2-3 s) → histoire avec progression → récompense satisfaisante → dernier plan qui fait commenter.' },
];
export const styleDef = (id: string | undefined) => STYLES.find(s => s.id === id) ?? STYLES[1];

// ── Techniques (mode « Analyser un script ») ──
export type TechniqueKind = 'hook' | 'promesse' | 'boucle' | 'fermeture' | 'rehook' | 'escalade' | 'obstacle' | 'setup' | 'payoff' | 'interrupt' | 'teaser' | 'sponsor' | 'cta';
export interface TechniqueDef { kind: TechniqueKind; label: string; color: string; desc: string }
export const TECHNIQUES: TechniqueDef[] = [
  { kind: 'hook', label: 'Hook', color: '#ff375f', desc: 'Arrête le scroll et confirme la miniature en moins de 5 s.' },
  { kind: 'promesse', label: 'Objectif / enjeux', color: '#ff9f0a', desc: 'Annonce ce qu\'on va accomplir, les enjeux chiffrés et le plan.' },
  { kind: 'teaser', label: 'Teaser', color: '#ffd60a', desc: 'Annonce les meilleurs moments à venir (« et bien plus encore »).' },
  { kind: 'boucle', label: 'Boucle ouverte', color: '#bf5af2', desc: 'Question laissée en suspens, annoncée à voix haute.' },
  { kind: 'setup', label: 'Setup', color: '#ac8e68', desc: 'Élément planté tôt pour être récolté plus tard.' },
  { kind: 'rehook', label: 'Re-hook', color: '#64d2ff', desc: 'Relance l\'attention : nouvelle question, révélation, nouvelle arme.' },
  { kind: 'escalade', label: 'Escalade', color: '#0a84ff', desc: 'Palier supérieur : on passe du petit test au gros.' },
  { kind: 'obstacle', label: 'Obstacle / rebondissement', color: '#ff6961', desc: 'Échec ou imprévu qui crée une mini-boucle.' },
  { kind: 'interrupt', label: 'Pattern interrupt', color: '#5e5ce6', desc: 'Blague, aparté, changement de rythme ou sound design.' },
  { kind: 'fermeture', label: 'Boucle fermée / retour', color: '#66d4cf', desc: 'Retour sur un fil parallèle ou réponse à une question ouverte.' },
  { kind: 'sponsor', label: 'Sponsor intégré', color: '#a2845e', desc: 'Sponsor justifié par l\'histoire.' },
  { kind: 'payoff', label: 'Payoff', color: '#30d158', desc: 'La promesse est livrée de la façon la plus satisfaisante.' },
  { kind: 'cta', label: 'CTA / sortie', color: '#8e8e93', desc: 'Sortie sèche, sans récap.' },
];
export const techniqueDef = (k: string) => TECHNIQUES.find(t => t.kind === k) ?? TECHNIQUES[3];

// ── Conseils locaux → point de la méthode + requête pour citer la base de connaissances ──
export type IssueType = 'greeting' | 'hookLong' | 'ctaEarly' | 'noPromise' | 'sponsorEarly' | 'deadZone' | 'longSentence'
  | 'noLoops' | 'fewEscalation' | 'noPayoff' | 'recap' | 'outroLong' | 'tooLong' | 'tooShort';
export const ISSUE_INFO: Record<IssueType, { method: string; query: string; topic: Topic }> = {
  greeting: { method: 'Méthode, point 1 — Hook < 5 s : pas de « salut à tous », pas de présentation', query: 'hook premières secondes sans présentation', topic: 'hook' },
  hookLong: { method: 'Méthode, point 1 — Hook < 5 s qui confirme la miniature', query: 'hook en moins de 5 secondes', topic: 'hook' },
  ctaEarly: { method: 'Méthode, point 8 — CTA intégré au récit, au milieu ; sortie sèche à la fin', query: 'demander de s\'abonner au début de la vidéo', topic: 'retention' },
  noPromise: { method: 'Méthode, point 2 — Objectif + enjeux + plan annoncé avant 30 s', query: 'annoncer objectif et enjeux au début promesse', topic: 'script' },
  sponsorEarly: { method: 'Méthode, point 8 — Sponsor intégré au récit, au milieu, comme une nécessité de l\'histoire', query: 'intégration sponsor milieu de vidéo', topic: 'script' },
  deadZone: { method: 'Méthode, point 4 — Boucles ouvertes en chaîne : jamais un moment où toutes les questions sont résolues', query: 're-hook régulier rétention boucle ouverte', topic: 'retention' },
  longSentence: { method: 'Méthode, point 8 — Rythme parlé : phrases courtes, oralité, lire à voix haute', query: 'phrases courtes rythme script parlé', topic: 'script' },
  noLoops: { method: 'Méthode, point 4 — Boucles ouvertes explicites, annoncées à voix haute', query: 'boucle ouverte curiosité annoncer la suite', topic: 'retention' },
  fewEscalation: { method: 'Méthode, point 6 — Escalade par paliers (au moins 3) + obstacles réels', query: 'escalade par paliers montée de tension', topic: 'script' },
  noPayoff: { method: 'Méthode, point 9 — Payoff final : la fin livre exactement la promesse du titre', query: 'payoff tenir la promesse du titre', topic: 'script' },
  recap: { method: 'Méthode, point 9 — Aucun récap, pas de « voilà c\'était tout »', query: 'fin de vidéo sans récapitulatif', topic: 'retention' },
  outroLong: { method: 'Checklist — Plus de 15 s après le payoff ? Couper.', query: 'outro courte après le payoff', topic: 'retention' },
  tooLong: { method: 'Méthode, point 8 — Couper tout ce qui n\'apporte ni enjeu, ni info, ni rire', query: 'couper les longueurs du script', topic: 'script' },
  tooShort: { method: 'Structures types — volume adapté au format', query: 'durée de vidéo et structure', topic: 'script' },
};

export const DEFAULT_WPM = 150;
