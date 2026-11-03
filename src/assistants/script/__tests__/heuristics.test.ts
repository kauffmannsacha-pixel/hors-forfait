import { describe, expect, it } from 'vitest';
import {
  analyzeScript, blocksFromPlainText, classifyLine, countWords, fmtClock, hookLocal, maskSpoken, requiredWpm, secondsFor, splitSentences, textOfRange,
} from '../heuristics';
import { flagsOf, isReHook } from '../patterns';
import { sectionKindOf } from '../method';

const flat = (n: number, word = 'mot') => Array.from({ length: n }, () => word).join(' ') + '.';

describe('comptage et débit (mots/minute)', () => {
  it('compte les mots parlés (élisions = 1 mot)', () => {
    expect(countWords("Salut à tous, aujourd'hui on teste l'IA !")).toBe(7);
    expect(countWords('')).toBe(0);
    expect(countWords('10 000 personnes — vraiment ?')).toBe(4);
  });
  it('convertit mots ↔ durée au débit choisi', () => {
    expect(secondsFor(150, 150)).toBe(60);
    expect(secondsFor(75, 150)).toBe(30);
    expect(secondsFor(100, 200)).toBe(30);
    expect(requiredWpm(1500, 600)).toBe(150);
    expect(requiredWpm(2000, 600)).toBe(200);
    expect(fmtClock(65)).toBe('1:05');
  });
  it('estime la durée totale et la durée des sections', () => {
    const blocks = blocksFromPlainText(`## Hook\n${flat(25)}\n## Corps\n${flat(150)}`);
    const a = analyzeScript(blocks, { wpm: 150 });
    expect(a.words).toBe(175);
    expect(Math.round(a.durationSec)).toBe(70);
    expect(a.sections.map(s => s.kind)).toEqual(['hook', 'corps']);
    expect(Math.round(a.sections[0].dur)).toBe(10);
    expect(Math.round(a.sections[1].start)).toBe(10);
    expect(Math.round(a.sections[1].dur)).toBe(60);
  });
  it('le débit réglable change le timing', () => {
    const blocks = blocksFromPlainText(flat(300));
    expect(Math.round(analyzeScript(blocks, { wpm: 150 }).durationSec)).toBe(120);
    expect(Math.round(analyzeScript(blocks, { wpm: 200 }).durationSec)).toBe(90);
  });
});

describe('voix vs indications', () => {
  it('ignore les lignes Visuel / Son / B-roll et les [indications]', () => {
    expect(classifyLine('Visuel : plan large sur la maison').kind).toBe('direction');
    expect(classifyLine('🔊 Son : bip d\'erreur').kind).toBe('direction');
    expect(classifyLine('B-roll : la box clignote').kind).toBe('direction');
    expect(classifyLine('Voix : « J\'ai oublié de payer ma facture »').kind).toBe('spoken');
    expect(classifyLine('Le plan : je lance un live').kind).toBe('spoken');
    const loop = classifyLine('Boucle : ouverte — vais-je réussir ?');
    expect(loop.kind).toBe('direction');
    expect(loop.loop).toBe('open');
    expect(classifyLine('Boucle : fermée (le mot de passe est trouvé)').loop).toBe('close');
    const m = maskSpoken('Voix : bonjour [SFX boom] toi (rires)', 6);
    expect(m.length).toBe('Voix : bonjour [SFX boom] toi (rires)'.length);
    expect(countWords(m)).toBe(2);
  });
  it('ne compte pas les indications dans le timing', () => {
    const a = analyzeScript(blocksFromPlainText(`Voix : ${flat(30)}\nVisuel : ${flat(200)}\nSon : musique tendue`), { wpm: 150 });
    expect(a.words).toBe(30);
  });
  it('les sections « Notes » / « Récap des boucles » ne sont pas parlées', () => {
    const a = analyzeScript(blocksFromPlainText(`## Hook\n${flat(10)}\n## Récap des boucles\n- ${flat(80)}`), {});
    expect(a.words).toBe(10);
    expect(sectionKindOf('Récap des boucles')).toBe('notes');
  });
});

describe('détection des boucles ouvertes', () => {
  it('détecte les motifs de la méthode (FR)', () => {
    for (const s of [
      'Vous verrez que plus tard dans cette vidéo, je partagerai ma carte bancaire.',
      'Mais avant ça, il me manque quand même un truc primordial : les gens.',
      'Retenez bien ça, on va y revenir, ça aura toute son importance.',
      "J'ai une idée encore plus diabolique.",
      'Est-ce que ce plan va marcher ?',
    ]) expect(flagsOf(s).openLoop, s).toBe(true);
    expect(flagsOf('Le ciel est bleu aujourd\'hui.').openLoop).toBe(false);
  });
  it('détecte les motifs anglais (analyse de vidéos MrBeast)', () => {
    expect(flagsOf('But before that, I need to buy a lot of cars.').openLoop).toBe(true);
    expect(flagsOf("Stay until the end because you won't believe it.").openLoop).toBe(true);
  });
  it('compte boucles, questions, rebondissements et paliers', () => {
    const txt = [
      'Je suis nul à Minecraft.',
      'Vous verrez plus tard dans cette vidéo ce que j\'ai trouvé.',
      'Comment je vais faire ?',
      'Sauf que le site a planté.',
      'Cette fois, on passe à 10 000 personnes.',
    ].join(' ');
    const a = analyzeScript(blocksFromPlainText(txt), {});
    expect(a.openLoops).toBe(1);
    expect(a.questions).toBe(1);
    expect(a.twists).toBe(1);
    expect(a.escalations).toBe(1);
  });
  it('compte les lignes « Boucle : ouverte » du format de la méthode', () => {
    const a = analyzeScript(blocksFromPlainText(`Voix : ${flat(10)}\nBoucle : ouverte — va-t-il se faire griller ?\nBoucle : fermée`), {});
    expect(a.loopNotes).toEqual({ open: 1, close: 1 });
    expect(a.openLoops).toBe(1);
  });
});

describe('moments morts', () => {
  it('signale un passage > 35 s sans question / teaser / rebondissement', () => {
    // 2 phrases de 60 mots (24 s chacune à 150 mots/min) sans relance = 48 s
    const txt = ['Est-ce que ça va marcher ?', flat(60, 'calme'), flat(60, 'plat'), 'Mais soudain, tout bascule.'].join('\n');
    const a = analyzeScript(blocksFromPlainText(txt), { wpm: 150 });
    expect(a.deadZones).toHaveLength(1);
    expect(Math.round(a.deadZones[0].dur)).toBe(48);
    const issue = a.issues.find(i => i.type === 'deadZone');
    expect(issue?.message).toMatch(/Ce passage de 48 s n'a aucun re-hook/);
    expect(issue?.range).toEqual({ b0: 1, o0: 0, b1: 2, o1: flat(60, 'plat').length });
  });
  it('aucun moment mort quand les relances sont régulières', () => {
    const txt = Array.from({ length: 6 }, (_, i) => `${flat(40)} Et là, qu'est-ce qui se passe ${i} ?`).join('\n');
    const a = analyzeScript(blocksFromPlainText(txt), { wpm: 150 });
    expect(a.deadZones).toHaveLength(0);
  });
  it('le seuil est réglable (30-40 s)', () => {
    const txt = ['Pourquoi ?', flat(80), 'Pourquoi ?'].join('\n'); // 32 s
    expect(analyzeScript(blocksFromPlainText(txt), { deadZoneSec: 35 }).deadZones).toHaveLength(0);
    expect(analyzeScript(blocksFromPlainText(txt), { deadZoneSec: 30 }).deadZones).toHaveLength(1);
  });
  it('isReHook reconnaît questions, teasers et paliers', () => {
    expect(isReHook(flagsOf('Et vous, vous auriez fait quoi ?'))).toBe(true);
    expect(isReHook(flagsOf('Cette fois, on passe au niveau supérieur.'))).toBe(true);
    expect(isReHook(flagsOf('Il fait beau.'))).toBe(false);
  });
});

describe('hook', () => {
  it('signale « salut à tous » et un hook > 5 s', () => {
    const a = analyzeScript(blocksFromPlainText(`Salut à tous, aujourd'hui on se retrouve pour une nouvelle vidéo.\n${flat(20)}`), {});
    expect(a.issues.some(i => i.type === 'greeting')).toBe(true);
    const b = analyzeScript(blocksFromPlainText(`${flat(25)}\nEst-ce que ça va marcher ?`), {});
    expect(b.hookSec).toBe(10);
    expect(b.issues.some(i => i.type === 'hookLong')).toBe(true);
  });
  it('un hook court et direct obtient une bonne note de hook', () => {
    const good = analyzeScript(blocksFromPlainText("J'ai oublié de payer ma facture Internet. Ma seule solution : pirater le Wi-Fi du voisin. Mais est-ce que ça va marcher ? Je vais tenter 10 000 mots de passe."), {});
    const bad = analyzeScript(blocksFromPlainText(`Salut à tous et bienvenue sur ma chaîne, je m'appelle Paul et aujourd'hui on se retrouve pour une nouvelle vidéo un peu spéciale.`), {});
    expect(hookLocal(good).score).toBeGreaterThan(hookLocal(bad).score);
    expect(good.parts.find(p => p.id === 'hook')!.score).toBeGreaterThanOrEqual(9);
  });
  it('détecte l\'objectif annoncé avant 30 s', () => {
    const a = analyzeScript(blocksFromPlainText("Je suis nul à Minecraft. Donc j'ai décidé de me venger. Mon plan : pirater un speedrun."), {});
    expect(a.promiseSec).not.toBeNull();
    expect(a.issues.some(i => i.type === 'noPromise')).toBe(false);
  });
});

describe('fin de script', () => {
  it('signale un récap et une sortie > 15 s', () => {
    const txt = `## Corps\n${flat(200)}\n## Payoff\nEnfin, on l'a fait !\n## CTA\nPour résumer, on a vu plein de choses. ${flat(60)}`;
    const a = analyzeScript(blocksFromPlainText(txt), {});
    expect(a.issues.some(i => i.type === 'recap')).toBe(true);
    expect(a.issues.some(i => i.type === 'outroLong')).toBe(true);
    expect(a.outroSec).toBeGreaterThan(15);
  });
});

describe('utilitaires', () => {
  it('découpe en phrases avec offsets exacts', () => {
    const t = 'Bonjour. Ça va ? Oui… « Super ! » Fin';
    const parts = splitSentences(t).map(r => t.slice(r.s, r.e));
    expect(parts).toEqual(['Bonjour.', 'Ça va ?', 'Oui…', '« Super ! »', 'Fin']);
  });
  it('textOfRange reconstitue un passage multi-blocs', () => {
    const blocks = blocksFromPlainText('Premier bloc.\nDeuxième bloc.\nTroisième bloc.');
    expect(textOfRange(blocks, { b0: 0, o0: 8, b1: 2, o1: 9 })).toBe('bloc.\nDeuxième bloc.\nTroisième');
  });
  it('score vide pour un script vide', () => {
    const a = analyzeScript([], {});
    expect(a.score).toBe(0);
    expect(a.issues).toHaveLength(0);
  });
  it('cibles par section selon la durée visée', () => {
    const blocks = blocksFromPlainText(`## Hook (0-30 s)\n${flat(20)}\n## Corps — montée de tension\n${flat(100)}\n## CTA\n${flat(10)}`);
    const a = analyzeScript(blocks, { targetSec: 600 });
    expect(a.sections[0].target).toBe(24);
    expect(a.sections[1].target).toBe(330);
    expect(a.sections[2].target).toBe(15);
    expect(a.sections[1].status).toBe('under');
  });
});
