import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE, QUANTUM, SpeedMeter, backoffDelay, contentRange, formatBytes, formatEta, isValidChunk, nextOffsetFromRange,
  normalizeChunkSize, planChunk, planChunks, statusContentRange,
} from '../chunks';

const MB = 1024 * 1024;

describe('découpage en morceaux (resumable upload)', () => {
  it('8 Mio = multiple de 256 Kio', () => {
    expect(CHUNK_SIZE % QUANTUM).toBe(0);
    expect(CHUNK_SIZE / QUANTUM).toBe(32);
  });

  it('planChunk : premier morceau et Content-Range', () => {
    const p = planChunk(0, 20 * MB);
    expect(p).toEqual({ offset: 0, len: 8 * MB, last: 8 * MB - 1, contentRange: `bytes 0-${8 * MB - 1}/${20 * MB}`, final: false });
  });

  it('planChunks : 8 + 8 + 4 Mio, seul le dernier peut ne pas être multiple de 256 Kio', () => {
    const total = 20 * MB + 12345;
    const plan = planChunks(total);
    expect(plan.map(p => p.len)).toEqual([8 * MB, 8 * MB, 4 * MB + 12345]);
    expect(plan[2].final).toBe(true);
    expect(plan[2].contentRange).toBe(`bytes ${16 * MB}-${total - 1}/${total}`);
    plan.slice(0, -1).forEach(p => expect(p.len % QUANTUM).toBe(0));
    plan.forEach(p => expect(isValidChunk(p.offset, p.len, total)).toBe(true));
    expect(plan.reduce((s, p) => s + p.len, 0)).toBe(total);
  });

  it('fichier plus petit qu’un morceau : un seul envoi', () => {
    expect(planChunks(1000)).toEqual([{ offset: 0, len: 1000, last: 999, contentRange: 'bytes 0-999/1000', final: true }]);
  });

  it('taille de morceau ramenée au multiple de 256 Kio inférieur', () => {
    expect(normalizeChunkSize(10_000_000)).toBe(38 * QUANTUM);
    expect(normalizeChunkSize(1000)).toBe(QUANTUM);
    expect(planChunk(0, 50 * MB, 10_000_000).len).toBe(38 * QUANTUM);
  });

  it('isValidChunk refuse un morceau intermédiaire non aligné', () => {
    expect(isValidChunk(0, QUANTUM + 1, 10 * MB)).toBe(false);
    expect(isValidChunk(0, QUANTUM, 10 * MB)).toBe(true);
    expect(isValidChunk(10 * MB - 5, 5, 10 * MB)).toBe(true);
    expect(isValidChunk(0, 11 * MB, 10 * MB)).toBe(false);
  });

  it('positions invalides', () => {
    expect(() => planChunk(-1, 10)).toThrow();
    expect(() => planChunk(10, 10)).toThrow();
    expect(() => planChunk(0, 0)).toThrow();
  });

  it('reprise : en-tête Range de la réponse 308', () => {
    expect(nextOffsetFromRange('bytes=0-999999')).toBe(1_000_000);
    expect(nextOffsetFromRange('bytes 0-524287')).toBe(524_288);
    expect(nextOffsetFromRange(null)).toBe(0);
    expect(nextOffsetFromRange(undefined)).toBe(0);
    const total = 20 * MB;
    const next = nextOffsetFromRange(`bytes=0-${4 * MB - 1}`);
    expect(planChunk(next, total).contentRange).toBe(`bytes ${4 * MB}-${12 * MB - 1}/${total}`);
  });

  it('Content-Range des demandes d’état', () => {
    expect(statusContentRange(2_000_000)).toBe('bytes */2000000');
    expect(contentRange(0, 524_288, 2_000_000)).toBe('bytes 0-524287/2000000');
  });
});

describe('attente exponentielle', () => {
  it('double à chaque tentative avec gigue entre 50 % et 100 %', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    const capped = backoffDelay(12, () => 0.5);
    expect(capped).toBeGreaterThanOrEqual(32_000);
    expect(capped).toBeLessThanOrEqual(64_000);
  });
  it('respecte Retry-After', () => {
    expect(backoffDelay(0, () => 0, 30)).toBe(30_000);
  });
});

describe('débit et temps restant', () => {
  it('calcule le débit sur la fenêtre et le temps restant', () => {
    const m = new SpeedMeter(20_000);
    m.add(0, 0); m.add(2 * MB, 1000); m.add(4 * MB, 2000);
    expect(m.bytesPerSec()).toBe(2 * MB);
    expect(m.eta(10 * MB)).toBe(5);
  });
  it('repart de zéro si le serveur a reçu moins que prévu', () => {
    const m = new SpeedMeter();
    m.add(0, 0); m.add(8 * MB, 1000); m.add(4 * MB, 1500);
    expect(m.bytesPerSec()).toBe(0);
  });
  it('formats lisibles', () => {
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(1536)).toBe('1,5 Ko');
    expect(formatEta(42)).toBe('42 s');
    expect(formatEta(3600 + 5 * 60)).toBe('1 h 05');
    expect(formatEta(null)).toBe('calcul…');
  });
});
