import { describe, expect, it } from 'vitest';
import { csvCell, parseCSV, safeFilename, toCSV } from '../lib/csv';

describe('export CSV', () => {
  it('produit un CSV Excel français : BOM, « ; », virgule décimale, CRLF', () => {
    const csv = toCSV(['Temps (s)', 'Rétention (%)'], [[0, 100], [1, 98.5]]);
    expect(csv).toBe('\uFEFFTemps (s);Rétention (%)\r\n0;100\r\n1;98,5\r\n');
  });
  it('échappe séparateurs, guillemets et retours à la ligne', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('il a dit "stop"')).toBe('"il a dit ""stop"""');
    expect(csvCell('ligne 1\nligne 2')).toBe('"ligne 1\nligne 2"');
    expect(csvCell(' espace ')).toBe('" espace "');
    expect(csvCell('a,b', { sep: ',' })).toBe('"a,b"');
  });
  it('formate nombres, booléens, dates et valeurs absentes', () => {
    expect(csvCell(0.1 + 0.2)).toBe('0,3');
    expect(csvCell(1234567.891)).toBe('1234567,891');
    expect(csvCell(-0)).toBe('0');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('oui');
    expect(csvCell(new Date('2026-11-03T10:00:00Z'))).toBe('2026-11-03T10:00:00.000Z');
    expect(csvCell(2.5, { decimal: '.' })).toBe('2.5');
  });
  it('neutralise l’injection de formules dans les cellules texte (pas dans les nombres)', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+33 6 00')).toBe('\'+33 6 00');
    expect(csvCell('-4 pts')).toBe('\'-4 pts');
    expect(csvCell(-4)).toBe('-4');
    expect(csvCell('=1', { guardFormulas: false })).toBe('=1');
  });
  it('options : séparateur virgule, sans BOM, fin de ligne LF', () => {
    expect(toCSV(['a', 'b'], [[1.5, 'x,y']], { sep: ',', decimal: '.', bom: false, newline: '\n' })).toBe('a,b\n1.5,"x,y"\n');
  });
  it('relecture : parseCSV inverse toCSV (guillemets, séparateurs, multi-lignes)', () => {
    const rows = [['t', 'phrase'], ['12', 'Il dit "non"; puis\npart'], ['13', '']];
    const csv = toCSV(rows[0], rows.slice(1), { guardFormulas: false });
    expect(parseCSV(csv, ';')).toEqual(rows);
  });
  it('parseCSV lit un rapport YouTube Reporting (virgules, CRLF, sans retour final)', () => {
    const text = 'date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\r\n20261101,UC1,abc,1200,0.051\r\n20261101,UC1,"d,e",30,0';
    expect(parseCSV(text)).toEqual([
      ['date', 'channel_id', 'video_id', 'video_thumbnail_impressions', 'video_thumbnail_impressions_ctr'],
      ['20261101', 'UC1', 'abc', '1200', '0.051'],
      ['20261101', 'UC1', 'd,e', '30', '0'],
    ]);
  });
  it('nom de fichier sûr', () => {
    expect(safeFilename('Rétention — Ma vidéo « test » !')).toBe('retention-ma-video-test');
    expect(safeFilename('???')).toBe('export');
  });
});
