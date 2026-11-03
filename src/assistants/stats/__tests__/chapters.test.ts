import { describe, expect, it } from 'vitest';
import { chapterAt, parseChapters, parseTimestamp, timestampLines } from '../lib/chapters';

describe('parseTimestamp', () => {
  it('convertit m:ss, mm:ss, h:mm:ss et les minutes > 59 sans heure', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('12:05')).toBe(725);
    expect(parseTimestamp('01:02:03')).toBe(3723);
    expect(parseTimestamp('75:30')).toBe(4530);
  });
  it('refuse les valeurs invalides', () => {
    expect(parseTimestamp('1:75')).toBeNull();
    expect(parseTimestamp('1:60:00')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('12')).toBeNull();
  });
});

describe('parseChapters', () => {
  const desc = [
    'Dans cette vidéo je pirate le Wi-Fi du voisin 😈',
    '',
    'CHAPITRES',
    '0:00 Intro',
    '0:45 - Le plan infaillible',
    '(02:10) Premier test : raté',
    '[5:03] – On passe aux choses sérieuses',
    '1:02:03 | Le grand final',
    '',
    'Musique : Lofi (licence 0:00 incluse) — merci !',
    'Rendez-vous demain à 18:00',
  ].join('\n');

  it('extrait titres et horodatages dans les formats courants', () => {
    const r = parseChapters(desc, 3800);
    expect(r.chapters.map(c => [c.start, c.title])).toEqual([
      [0, 'Intro'],
      [45, 'Le plan infaillible'],
      [130, 'Premier test : raté'],
      [303, 'On passe aux choses sérieuses'],
      [3723, 'Le grand final'],
    ]);
  });
  it('calcule la fin de chaque chapitre (début du suivant, durée pour le dernier)', () => {
    const r = parseChapters(desc, 3800);
    expect(r.chapters[0].end).toBe(45);
    expect(r.chapters[4].end).toBe(3800);
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });
  it('ignore les phrases qui contiennent une heure hors de la liste', () => {
    const r = parseChapters(desc, 3800);
    expect(r.chapters.some(c => /Rendez-vous|Musique/.test(c.title))).toBe(false);
  });
  it('accepte l’horodatage en fin de ligne et les plages « 0:00 - 1:30 »', () => {
    const r = parseChapters('Intro - 0:00\nLe test (1:30)\nLa fin 3:00', 240);
    expect(r.chapters.map(c => [c.start, c.title])).toEqual([[0, 'Intro'], [90, 'Le test'], [180, 'La fin']]);
    const r2 = parseChapters('0:00 - 1:30 Intro\n1:30 - 3:00 Corps\n3:00 Fin', 240);
    expect(r2.chapters.map(c => c.title)).toEqual(['Intro', 'Corps', 'Fin']);
  });
  it('signale les règles YouTube non respectées', () => {
    const noZero = parseChapters('0:30 Début\n1:00 Milieu\n2:00 Fin', 300);
    expect(noZero.valid).toBe(false);
    expect(noZero.issues.join(' ')).toMatch(/0:00/);
    expect(noZero.chapters.map(c => c.start)).toEqual([30, 60, 120]);

    const two = parseChapters('0:00 A\n1:00 B', 300);
    expect(two.valid).toBe(false);
    expect(two.issues.join(' ')).toMatch(/au moins 3/);

    const tooShort = parseChapters('0:00 A\n0:05 B\n1:00 C', 300);
    expect(tooShort.valid).toBe(false);
    expect(tooShort.issues.join(' ')).toMatch(/10 s/);
  });
  it('arrête la liste au premier horodatage non croissant et ignore ceux au-delà de la durée', () => {
    const r = parseChapters('0:00 A\n1:00 B\n2:00 C\n0:30 Rappel\n3:00 D', 300);
    expect(r.chapters.map(c => c.title)).toEqual(['A', 'B', 'C']);
    const beyond = parseChapters('0:00 A\n1:00 B\n2:00 C\n9:00 Hors vidéo', 300);
    expect(beyond.chapters.length).toBe(3);
    expect(beyond.issues.join(' ')).toMatch(/au-delà/);
  });
  it('donne un titre par défaut et gère une description vide', () => {
    expect(parseChapters('0:00\n1:00 B\n2:00 C', 200).chapters[0].title).toBe('Chapitre 1');
    expect(parseChapters('', 100)).toEqual({ chapters: [], valid: false, issues: [] });
    expect(timestampLines('pas de chapitres ici')).toEqual([]);
  });
});

describe('chapterAt', () => {
  const { chapters } = parseChapters('0:00 Intro\n1:00 Corps\n5:00 Fin', 400);
  it('renvoie le chapitre en cours', () => {
    expect(chapterAt(chapters, 0)?.title).toBe('Intro');
    expect(chapterAt(chapters, 59.9)?.title).toBe('Intro');
    expect(chapterAt(chapters, 60)?.title).toBe('Corps');
    expect(chapterAt(chapters, 399)?.title).toBe('Fin');
    expect(chapterAt([], 10)).toBeNull();
  });
});
