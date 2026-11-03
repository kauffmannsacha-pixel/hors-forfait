// Motifs de détection (FR + EN) issus de la méthode de scripting (docs/methode-scripting.md).
// Utilisés par le score en direct (heuristiques locales) et par l'analyse de transcriptions.

/** Construit une regex insensible à la casse avec des frontières de mots compatibles accents. */
export function words(...alts: string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}
/** Regex ancrée en début de phrase (après guillemets / tirets éventuels). */
export function starts(...alts: string[]): RegExp {
  return new RegExp(`^[\\s«"“'‘\\-–—…]*(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

/** Normalise une phrase avant détection (apostrophes typographiques, espaces insécables). */
export const normalizeForMatch = (s: string) => s.replace(/[’‘`´]/g, "'").replace(/[  ]/g, ' ');

const any = (res: RegExp[], s: string) => res.some(r => r.test(s));

// ── Boucles ouvertes : teasers, annonces, éléments plantés (point 4 de la méthode) ──
export const OPEN_LOOP: RegExp[] = [
  words('plus tard', "mais avant (?:ça|ca|cela|tout|de)", "mais d'abord", "avant (?:ça|ca|cela),"),
  words("(?:on|je) (?:y )?reviendr(?:a|ai|ons)", 'on va y revenir', "j'y reviens", "on y revient"),
  words('retenez(?:-le| bien| (?:ça|ca|ce))', "gardez (?:bien )?(?:ça|ca) en (?:t[êe]te|m[ée]moire)", 'notez bien'),
  words("(?:ça|ca|cela) (?:aura|va avoir) (?:toute )?son importance"),
  words('vous (?:allez|verrez|aller) (?:voir|comprendre|halluciner|pas croire)', 'vous verrez', 'vous allez voir'),
  words('(?:à|a) la fin (?:de (?:la|cette) vid[ée]o)', "jusqu'(?:à|a) la fin", 'restez (?:bien )?jusqu', 'juste apr[èe]s'),
  words('dans (?:quelques|deux|trois|cinq|\\d+) (?:secondes|minutes)'),
  words('je vous (?:montre|dis|explique|raconte|r[ée]v[èe]le) (?:ça|ca|tout|pourquoi|comment|la suite|ce qui)'),
  words('attendez(?:-vous)? (?:de voir|la suite)', "(?:ce n'est|c'est) pas (?:tout|fini)", "ce n'est que le d[ée]but"),
  words('spoiler', "vous (?:n'allez|allez) (?:jamais |pas )(?:croire|deviner)"),
  words('(?:il )?(?:me|nous) manque (?:quand m[êe]me |encore )?(?:un|une|le|la)'),
  words("j'ai (?:une|eu une) (?:autre )?id[ée]e (?:encore )?plus"),
  words('(?:on|je) (?:va|vais) voir si', 'est-ce que (?:ça|ca|ce plan|mon plan) (?:va )?(?:marcher|fonctionner|passer)'),
  words('on commence par', 'pour (?:la|le) fin', 'bien plus encore', 'sans (?:me|nous) faire (?:cramer|griller|attraper|prendre)'),
  // EN
  words('later (?:in|on)', 'but (?:first|before that)', '(?:stay|stick around) (?:until|till|to) the end', "you(?:'ll| will) see"),
  words('at the end of (?:this|the) video', 'keep (?:that|this) in mind', 'remember (?:this|that)', "but that'?s not all"),
  words('coming up', 'in a (?:minute|second|moment|bit)', '(?:wait|hold on) (?:until|till) you see', "you won'?t believe"),
  words('what happen(?:s|ed) next', 'will (?:it|this|he|she|they|i) (?:work|survive|win|make it)', 'and (?:so )?much more'),
];

// ── Rebondissements / obstacles (point 6) ──
export const TWIST: RegExp[] = [
  starts('mais', "sauf qu", 'probl[èe]me', 'seul (?:souci|probl[èe]me)', 'seulement', 'malheureusement', 'soudain(?:ement)?',
    'et l[àa]', 'tout (?:à|a) coup', 'catastrophe', 'attendez', 'attends', 'oh non', 'et pourtant', 'pourtant'),
  words('sauf que', 'coup de th[ée][âa]tre', 'plot twist', 'rebondissement', "rien ne s'est pass[ée] comme pr[ée]vu"),
  words("(?:ça|ca) (?:a|s'est) (?:mal )?tourn[ée]", "on (?:s'est fait|se fait|va se faire) (?:griller|cramer|ban(?:nir)?|attraper|prendre)"),
  words("(?:ça|ca|ce plan|le plan) (?:n'a|a) (?:pas|jamais) (?:march[ée]|fonctionn[ée])", '(?:ça|ca) ne marche pas', '[ée]chec',
    "(?:c'est|c'était) impossible", 'je me suis fait (?:griller|cramer|ban(?:nir)?|avoir)', 'impr[ée]vu', 'en r[ée]alit[ée]'),
  words("j'(?:ai|avais) (?:oubli[ée]|rat[ée]|perdu)", 'il ne (?:me |nous )?reste (?:que|plus)'),
  starts('but', 'however', 'suddenly', 'unfortunately', 'until'),
  words('plot twist', 'out of nowhere', "didn'?t work", 'nothing went as planned', 'got (?:caught|banned)', 'turns out', 'in reality', 'the problem (?:is|was)'),
];

// ── Retours / fils parallèles / boucles refermées (point 5) ──
export const CALLBACK: RegExp[] = [
  words('je vous rappelle', 'rappelez-vous', 'souvenez-vous', 'vous (?:vous )?(?:souvenez|rappelez)', 'comme promis', "je vous l'avais (?:dit|promis)"),
  words('(?:retournons|revenons|on retourne|on revient) (?:voir|à|a|au|aux|sur)', 'pendant (?:que|ce temps)', 'depuis le d[ée]but'),
  words('(?:le moment|l\'heure) (?:est venu|de v[ée]rit[ée])', 'dont je ne vous ai pas parl[ée]'),
  words('as promised', 'remember (?:when|the)', '(?:back|going back) to', 'meanwhile', 'the moment of truth', 'since the (?:beginning|start)'),
];
export const CLOSE_LOOP: RegExp[] = [
  words('comme promis', "je vous l'avais (?:dit|promis)", "(?:le moment|l'heure) (?:est venu|de v[ée]rit[ée])", 'as promised', 'the moment of truth'),
];

// ── Escalade par paliers (point 6) ──
export const ESCALATION: RegExp[] = [
  words('encore plus', '(?:cran|niveau|vitesse) sup[ée]rieur[e]?', "on monte d'un cran", 'cette fois(?:-ci)?', '\\d+ fois plus', 'on double'),
  words('plus (?:gros|grand|grosse|fou|folle|dur|difficile|loin|extr[êe]me|risqu[ée]|dangereux|dingue|ambitieux)'),
  words("(?:deuxi[èe]me|troisi[èe]me|dernier|derni[èe]re|prochain|prochaine|nouvelle|nouveau) (?:test|essai|[ée]tape|niveau|d[ée]fi|palier|victime|cible|arme|plan)"),
  words('(?:ultime|final|finale) (?:test|d[ée]fi|niveau|boss|[ée]tape)', '(?:test|[ée]tape|palier|niveau) (?:2|3|4|5|deux|trois|quatre|cinq)'),
  words('passons (?:à|a|aux?)', 'on passe (?:à|a|au|aux) (?:la vitesse|l\'[ée]tape|niveau|la suite|du lourd)', '(?:et )?maintenant,? (?:on|je) (?:passe|attaque|va)'),
  words('even (?:more|bigger|crazier|harder)', 'next level', 'this time', 'final (?:test|challenge|level|boss)', '\\d+ times (?:more|bigger)', 'level (?:2|3|two|three)'),
];

// ── Objectif / promesse / enjeux (point 2) ──
export const OBJECTIVE: RegExp[] = [
  words("(?:je|on) (?:vais|va|dois|doit|veux|veut|compte|essaie|tente|tenter) ", 'mon (?:objectif|but|plan|d[ée]fi|id[ée]e|mission)', "l'objectif", 'le but', 'le plan'),
  words("j'ai d[ée]cid[ée]", "aujourd'hui,? (?:je|on|j')", 'd[ée]fi', 'challenge', 'si (?:je|on) (?:r[ée]ussi[st]?|gagne|perd|y arrive)'),
  words('pendant \\d+ (?:jours|heures|minutes|semaines|mois)', 'en moins de \\d+', '(?:r[ée]ussir|parvenir|arriver) (?:à|a)', 'ma seule solution'),
  words("(?:i'?m|i am|we'?re|we are) (?:going to|gonna|trying to)", 'my (?:goal|plan|mission)', 'the (?:goal|plan|challenge)', 'i (?:decided|have to|need to)', 'if (?:i|we) (?:win|lose|fail|succeed|survive)', 'for \\d+ (?:days|hours)'),
];
export const STAKES: RegExp[] = [
  /\d[\d\s.,]*\s?(?:€|\$|euros?|dollars?|personnes|abonn[ée]s|jours|heures|minutes|vues|robux|ans|mois|millions?|milliards?|kilom[èe]tres|km|people|subscribers|days|hours|years|million)/iu,
  words('prison', 'amende', 'banni', 'ban', 'risque', 'danger(?:eux)?', 'jail', 'banned', 'risk'),
];

// ── Tueurs de hook (point 1) ──
export const GREETING: RegExp[] = [
  starts('(?:salut|bonjour|coucou|hello|hey|yo|wesh)(?:\\s+(?:à|a) (?:tous|toutes|tout le monde|vous)|\\s+(?:tout le monde|les amis|les copains|la team|la famille|les gars|les loulous)|\\s*[,!.]|\\s*$)'),
  words('bienvenue (?:sur|dans) (?:ma|cette|la) (?:cha[îi]ne|vid[ée]o)', "je m'appelle", "(?:aujourd'hui )?on se retrouve", '(?:dans|pour) (?:cette|une) nouvelle vid[ée]o', 'avant de commencer'),
  starts("(?:hey|hi|hello|what'?s up) (?:guys|everyone|everybody)"),
  words('welcome (?:back )?to (?:my|the) channel', 'my name is'),
];
export const CTA_EARLY: RegExp[] = [
  words("(?:n')?oubliez pas de (?:vous abonner|liker|mettre un (?:pouce|like)|activer la cloche)", 'abonnez-vous', '(?:mettez|lâchez|laissez) un (?:like|pouce)', 'activez la cloche'),
  words("don'?t forget to (?:subscribe|like)", 'hit the (?:bell|subscribe)', 'smash (?:that|the) like'),
];
export const RECAP: RegExp[] = [
  words('pour (?:r[ée]sumer|conclure|finir)', 'en (?:r[ée]sum[ée]|conclusion)', "voil[àa],? c'(?:é|e)tait (?:tout|la vid[ée]o)", "c'est tout pour (?:aujourd'hui|cette vid[ée]o|moi)"),
  words('on se retrouve (?:dans|pour) (?:la|une) prochaine', "(?:j'esp[èe]re|en esp[ée]rant) que (?:cette vid[ée]o|ça|ca) (?:vous )?a plu", "merci d'avoir regard[ée]"),
  words('to (?:sum up|summarize|recap)', 'in conclusion', "that'?s (?:it|all) for (?:today|this video)", 'thanks for watching'),
];
export const SPONSOR: RegExp[] = [
  words('sponsor(?:is[ée]e?|ise|ing|ed)?', 'partenaire de (?:cette|la) vid[ée]o', 'code promo', 'lien en description', 'promo code', 'link in (?:the )?description'),
];
export const PAYOFF: RegExp[] = [
  words('enfin', 'finalement', 'au final', 'verdict', 'le moment de v[ée]rit[ée]', "(?:on|j'ai|je l'ai|on l'a) (?:a )?r[ée]ussi", "c'est fait", "on l'a fait", 'victoire'),
  words('la r[ée]ponse (?:est|[ée]tait)', 'la r[ée]v[ée]lation', 'voici (?:le|la|les) (?:r[ée]sultat|mot de passe|r[ée]ponse|v[ée]rit[ée])'),
  words('finally', 'the result', 'we did it', 'i did it', 'the answer (?:is|was)', 'moment of truth'),
];
export const INTERRUPT: RegExp[] = [
  words('je (?:rigole|plaisante)', "c'est une blague", 'lol', 'mdr', 'ptdr', 'vid[ée]o [ée]ducative', 'ne faites pas (?:ça|ca)', '(?:moi|lui) du pass[ée]', '\\(rires?\\)'),
  words('just kidding', "don'?t try this at home", 'anyway'),
];
export const SETUP: RegExp[] = [
  words('retenez (?:bien )?(?:ça|ca|ce)', "gardez (?:ça|ca) en t[êe]te", "(?:ça|ca) aura (?:toute )?son importance", 'notez bien', 'remember (?:this|that)', 'keep (?:this|that) in mind'),
];

export interface SentenceFlags {
  question: boolean; openLoop: boolean; twist: boolean; callback: boolean; close: boolean; escalation: boolean;
  objective: boolean; stakes: boolean; greeting: boolean; ctaEarly: boolean; recap: boolean; sponsor: boolean;
  payoff: boolean; interrupt: boolean; setup: boolean;
}

/** Détecte toutes les techniques présentes dans une phrase parlée. */
export function flagsOf(sentence: string): SentenceFlags {
  const s = normalizeForMatch(sentence).trim();
  return {
    question: /\?[\s»"”')\]]*$/.test(s),
    openLoop: any(OPEN_LOOP, s),
    twist: any(TWIST, s),
    callback: any(CALLBACK, s),
    close: any(CLOSE_LOOP, s),
    escalation: any(ESCALATION, s),
    objective: any(OBJECTIVE, s),
    stakes: any(STAKES, s),
    greeting: any(GREETING, s),
    ctaEarly: any(CTA_EARLY, s),
    recap: any(RECAP, s),
    sponsor: any(SPONSOR, s),
    payoff: any(PAYOFF, s),
    interrupt: any(INTERRUPT, s),
    setup: any(SETUP, s),
  };
}
/** Une phrase « relance » l'attention (sert à détecter les moments morts). */
export const isReHook = (f: SentenceFlags) => f.question || f.openLoop || f.twist || f.callback || f.escalation;
