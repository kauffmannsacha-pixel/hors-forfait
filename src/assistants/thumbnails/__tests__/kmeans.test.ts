import { describe, expect, it } from 'vitest';
import { dominantColors, kmeans, mulberry32 } from '../lib/kmeans';
import { createImage, fillRect } from '../lib/raster';
import { deltaE, rgbToLab, type RGB } from '../lib/color';

/** Image 200×100 : 50 % rouge, 30 % bleu, 20 % blanc (bandes verticales). */
function threeColorImage(noise = 0, seed = 3) {
  const img = createImage(200, 100);
  fillRect(img, { x: 0, y: 0, w: 100, h: 100 }, [230, 20, 30]);
  fillRect(img, { x: 100, y: 0, w: 60, h: 100 }, [20, 60, 220]);
  fillRect(img, { x: 160, y: 0, w: 40, h: 100 }, [250, 250, 250]);
  if (noise) {
    const rnd = mulberry32(seed);
    for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) img.data[i + c] = img.data[i + c] + (rnd() * 2 - 1) * noise;
  }
  return img;
}

describe('k-means des couleurs dominantes', () => {
  it('retrouve 3 couleurs pures et leurs proportions', () => {
    const pal = dominantColors(threeColorImage(), 5);
    expect(pal.length).toBe(3); // 5 demandés mais seulement 3 couleurs distinctes
    expect(pal[0].share).toBeCloseTo(0.5, 1);
    expect(pal[1].share).toBeCloseTo(0.3, 1);
    expect(pal[2].share).toBeCloseTo(0.2, 1);
    expect(pal[0].family).toBe('rouge');
    expect(pal[1].family).toBe('bleu');
    expect(pal[2].family).toBe('blanc');
    expect(pal.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1, 5);
  });

  it('reste précis avec du bruit (ΔE < 6 par rapport aux couleurs d’origine)', () => {
    const pal = dominantColors(threeColorImage(18), 3);
    const truth: RGB[] = [[230, 20, 30], [20, 60, 220], [250, 250, 250]];
    truth.forEach((t, i) => expect(deltaE(rgbToLab(t), pal[i].lab)).toBeLessThan(6));
  });

  it('est déterministe à graine égale', () => {
    const img = threeColorImage(25, 9);
    const a = dominantColors(img, 4, { seed: 11 }), b = dominantColors(img, 4, { seed: 11 });
    expect(a.map(p => p.hex)).toEqual(b.map(p => p.hex));
  });

  it('gère les cas limites (aucun point, k > n)', () => {
    expect(kmeans([], 3, 4).centers).toEqual([]);
    const r = kmeans([1, 1, 1, 9, 9, 9], 3, 5, { seed: 2 });
    expect(r.centers.length).toBe(2);
    expect(r.counts.reduce((s, c) => s + c, 0)).toBe(2);
  });

  it('converge sur des nuages 2D bien séparés', () => {
    const rnd = mulberry32(5); const pts: number[] = [];
    const truth = [[0, 0], [10, 10], [-10, 8]];
    for (const [cx, cy] of truth) for (let i = 0; i < 200; i++) pts.push(cx + (rnd() - 0.5), cy + (rnd() - 0.5));
    const r = kmeans(pts, 2, 3, { seed: 4 });
    for (const [cx, cy] of truth) expect(Math.min(...r.centers.map(c => Math.hypot(c[0] - cx, c[1] - cy)))).toBeLessThan(0.2);
    expect([...r.counts].sort()).toEqual([200, 200, 200]);
  });
});
