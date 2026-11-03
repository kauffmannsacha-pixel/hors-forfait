import { describe, expect, it } from 'vitest';
import {
  analyzeTitle, DESKTOP_VISIBLE, fmtViews, liftOf, localTitleScore, median, MOBILE_VISIBLE, nicheStats, parseChannelInput, textOverlap, titleLength, truncateTitle,
} from '../analyze';

describe('analyse d\'un titre', () => {
  it('longueur, chiffres, 1re personne et pattern défi chronométré', () => {
    const f = analyzeTitle("J'ai survécu 100 jours dans Minecraft Hardcore");
    expect(f.length).toBe(46);
    expect(f.hasNumber).toBe(true);
    expect(f.numbers).toEqual(['100']);
    expect(f.bigNumber).toBe(true);
    expect(f.firstPerson).toBe(true);
    expect(f.patterns).toContain('defi-duree');
    expect(f.pattern).toBe('experience');
  });
  it('mots puissants FR et EN', () => {
    expect(analyzeTitle('Le SECRET interdit que personne ne connaît').powerWords).toEqual(expect.arrayContaining(['secret', 'interdit', 'personne']));
    expect(analyzeTitle('I Survived The Most Dangerous Trap', 'en').powerWords).toEqual(expect.arrayContaining(['survived', 'dangerous', 'trap']));
    expect(analyzeTitle('Une journée normale').powerWords).toEqual([]);
  });
  it('curiosité, question, émotions et majuscules', () => {
    const f = analyzeTitle('Pourquoi personne ne parle de ÇA ?');
    expect(f.question).toBe(true);
    expect(f.curiosity.length).toBeGreaterThan(1);
    expect(f.pattern).toBe('interdit-secret');
    expect(analyzeTitle('Le cauchemar le plus terrifiant').emotions).toContain('peur');
    expect(analyzeTitle('Le MEILLEUR jeu GRATUIT de la NASA').capsWords).toBe(2);
  });
  it('compte les emojis comme un caractère', () => {
    expect(titleLength('Défi 🔥')).toBe(6);
  });
});

describe('troncature mobile / desktop', () => {
  const long = "J'ai piégé 10 000 personnes avec un faux mot de passe Netflix et voilà ce qui s'est passé";
  it('coupe à un espace avant ~50 caractères et ajoute …', () => {
    const t = truncateTitle(long, MOBILE_VISIBLE);
    expect(t.truncated).toBe(true);
    expect(t.visible.endsWith('…')).toBe(true);
    expect(titleLength(t.visible)).toBeLessThanOrEqual(MOBILE_VISIBLE);
    expect(t.visible).toBe("J'ai piégé 10 000 personnes avec un faux mot de…");
    expect(`${t.visible.slice(0, -1)} ${t.hidden}`).toBe(long);
  });
  it('ne tronque pas un titre court', () => {
    expect(truncateTitle('Titre court', MOBILE_VISIBLE)).toEqual({ visible: 'Titre court', hidden: '', truncated: false });
    expect(truncateTitle(long, DESKTOP_VISIBLE).truncated).toBe(true);
    expect(truncateTitle(long, 120).truncated).toBe(false);
  });
  it('coupe franche si un mot très long empêche de couper à un espace', () => {
    const t = truncateTitle('a ' + 'x'.repeat(80), 50);
    expect(titleLength(t.visible)).toBe(50);
  });
});

describe('statistiques de niche', () => {
  const items = [
    { title: "J'ai survécu 100 jours en Hardcore", views: 5_000_000 },
    { title: "J'ai passé 24h dans une prison", views: 3_000_000 },
    { title: '10 secrets que personne ne connaît', views: 2_000_000 },
    { title: 'Mon avis sur la mise à jour', views: 100_000 },
    { title: 'Petite session tranquille', views: 50_000 },
    { title: 'On teste le nouveau mode', views: 80_000 },
    { title: 'Pourquoi tout le monde quitte ce jeu ?', views: 400_000 },
  ];
  it('parts, médiane et lift des chiffres', () => {
    const s = nicheStats(items);
    expect(s.count).toBe(7);
    expect(s.share.number).toBe(43);
    expect(s.share.question).toBe(14);
    expect(s.medianViews).toBe(400_000);
    expect(s.lift.number).toBe(Math.round((3_000_000 / 90_000) * 100) / 100);
    expect(s.top[0].views).toBe(5_000_000);
    expect(s.lengthBuckets.reduce((n, b) => n + b.count, 0)).toBe(7);
    expect(s.patterns.reduce((n, p) => n + p.count, 0)).toBe(7);
  });
  it('médiane et lift robustes', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(liftOf([{ views: 1 }, { views: 2 }], [true, false])).toBeNull();
  });
});

describe('score local et utilitaires', () => {
  it('un titre court, chiffré et curieux bat un titre plat et trop long', () => {
    const good = localTitleScore("J'ai piraté le Wi-Fi de mon voisin (il m'a vu)");
    const bad = localTitleScore('vlog du jour où je vais faire des courses au supermarché et ranger ma chambre tranquillement');
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.reasons.join(' ')).toMatch(/trop long/);
  });
  it('pénalise la répétition du texte de la miniature', () => {
    const rep = localTitleScore('Le Wi-Fi du voisin piraté', { thumbnailText: 'WI-FI VOISIN PIRATÉ' });
    expect(rep.reasons.join(' ')).toMatch(/Répète le texte de la miniature/);
    expect(textOverlap('Le Wi-Fi du voisin piraté', 'voisin piraté')).toBe(1);
  });
  it('reconnaît chaîne, @handle et mots-clés', () => {
    expect(parseChannelInput('https://www.youtube.com/@MrBeast')).toEqual({ kind: 'handle', handle: '@MrBeast' });
    expect(parseChannelInput('UCX6OQ3DkcsbYNE6H8uQQuVA')).toEqual({ kind: 'id', id: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });
    expect(parseChannelInput('minecraft hardcore')).toEqual({ kind: 'keywords', q: 'minecraft hardcore' });
  });
  it('formate les vues', () => {
    expect(fmtViews(1_200_000)).toBe('1,2 M');
    expect(fmtViews(3_000_000)).toBe('3 M');
    expect(fmtViews(12_400)).toBe('12 k');
    expect(fmtViews(950)).toBe('950');
  });
});
