import { describe, expect, it } from 'vitest';
import { computeMetrics, smallFormatLegibility, SMALL_H, SMALL_W } from '../lib/metrics';
import { createImage, crop169, detectLetterbox, downscaleArea, fillRect } from '../lib/raster';

const W = 1280, H = 720;
const boldSquare = () => { const img = createImage(W, H, [255, 255, 255]); fillRect(img, { x: 290, y: 165, w: 700, h: 390 }, [0, 0, 0]); return img; };
const lowContrast = () => { const img = createImage(W, H, [130, 130, 130]); fillRect(img, { x: 290, y: 165, w: 700, h: 390 }, [120, 120, 120]); return img; };
const fineStripes = () => {
  const img = createImage(W, H, [255, 255, 255]);
  for (let x = 0; x < W; x += 2) fillRect(img, { x, y: 0, w: 1, h: H }, [0, 0, 0]);
  return img;
};

describe('rendu petit format', () => {
  it('réduit en 168×94 par moyenne de surface en conservant la couleur moyenne', () => {
    const uni = downscaleArea(createImage(W, H, [200, 40, 90]), SMALL_W, SMALL_H);
    expect([uni.width, uni.height]).toEqual([168, 94]);
    for (let i = 0; i < uni.data.length; i += 4) expect([uni.data[i], uni.data[i + 1], uni.data[i + 2]]).toEqual([200, 40, 90]);
    const half = createImage(W, H, [0, 0, 0]); fillRect(half, { x: 0, y: 0, w: W / 2, h: H }, [255, 255, 255]);
    const s = downscaleArea(half, SMALL_W, SMALL_H);
    let sum = 0; for (let i = 0; i < s.data.length; i += 4) sum += s.data[i];
    expect(sum / (s.data.length / 4)).toBeCloseTo(127.5, 0);
  });
});

describe('lisibilité en petit format', () => {
  it('un sujet massif très contrasté est lisible', () => {
    const l = smallFormatLegibility(boldSquare());
    expect([l.width, l.height]).toEqual([168, 94]);
    expect(l.contrastRatio).toBeGreaterThan(7);
    expect(l.score).toBeGreaterThanOrEqual(7.5);
  });
  it('un sujet gris sur gris est illisible', () => {
    const l = smallFormatLegibility(lowContrast());
    expect(l.contrastRatio).toBeLessThan(1.3);
    expect(l.score).toBeLessThan(2);
  });
  it('des détails fins disparaissent une fois réduits', () => {
    const fine = smallFormatLegibility(fineStripes());
    const bold = smallFormatLegibility(boldSquare());
    expect(fine.rms).toBeLessThan(0.03);
    expect(fine.score).toBeLessThan(3);
    expect(bold.score - fine.score).toBeGreaterThan(5);
  });
});

describe('mesures complètes', () => {
  it('place le point focal sur le sujet et note le contraste', () => {
    const img = createImage(W, H, [20, 24, 30]);
    fillRect(img, { x: 820, y: 180, w: 260, h: 260 }, [255, 210, 0]); // sujet jaune à droite
    const m = computeMetrics(img);
    expect(m.focal.x).toBeGreaterThan(0.6);
    expect(m.focal.x).toBeLessThan(0.86);
    expect(m.focal.y).toBeGreaterThan(0.25);
    expect(m.focal.y).toBeLessThan(0.6);
    expect(m.focalContrast).toBeGreaterThan(4.5);
    expect(m.palette[0].family).toBe('noir');
    expect(m.palette.some(p => p.family === 'jaune')).toBe(true);
    expect(m.scores.legibility).toBeGreaterThan(6);
    expect(m.saliency.w).toBe(48);
  });
  it('détecte les bandes noires des vignettes 4:3 et le recadrage 16:9', () => {
    const hq = createImage(480, 360, [0, 0, 0]); fillRect(hq, { x: 0, y: 45, w: 480, h: 270 }, [200, 120, 40]);
    expect(detectLetterbox(hq)).toEqual({ x: 0, y: 45, w: 480, h: 270 });
    expect(detectLetterbox(createImage(480, 360, [200, 120, 40]))).toBeNull();
    expect(crop169(1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    const sq = crop169(1000, 1000);
    expect(sq.w / sq.h).toBeCloseTo(16 / 9, 6);
    expect(sq.y).toBeCloseTo((1000 - 562.5) / 2, 6);
  });
});
