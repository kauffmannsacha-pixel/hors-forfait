import { describe, expect, it } from 'vitest';
import { colorFamily, contrastRatio, hexToRgb, labToRgb, readableOn, relativeLuminance, rgbToHex, rgbToLab, wcagLevel } from '../lib/color';

describe('contraste WCAG 2.x', () => {
  it('noir/blanc = 21:1, couleur identique = 1:1', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([120, 30, 200], [120, 30, 200])).toBeCloseTo(1, 5);
  });
  it('est symétrique', () => {
    expect(contrastRatio([255, 0, 0], [0, 0, 255])).toBeCloseTo(contrastRatio([0, 0, 255], [255, 0, 0]), 10);
  });
  it('valeurs de référence connues', () => {
    expect(contrastRatio(hexToRgb('#777777'), hexToRgb('#ffffff'))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(hexToRgb('#ff0000'), hexToRgb('#ffffff'))).toBeCloseTo(4.0, 1);
    expect(contrastRatio(hexToRgb('#0000ff'), hexToRgb('#ffffff'))).toBeCloseTo(8.59, 2);
    expect(contrastRatio(hexToRgb('#ffff00'), hexToRgb('#000000'))).toBeCloseTo(19.56, 2);
  });
  it('luminance relative : bornes et vert dominant', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
    expect(relativeLuminance([0, 255, 0])).toBeCloseTo(0.7152, 4);
  });
  it('niveaux WCAG', () => {
    expect(wcagLevel(7.2)).toBe('AAA');
    expect(wcagLevel(4.6)).toBe('AA');
    expect(wcagLevel(3.2)).toBe('AA grand texte');
    expect(wcagLevel(2.1)).toBe('insuffisant');
    expect(wcagLevel(3.2, true)).toBe('AA');
  });
  it('couleur de texte lisible', () => {
    expect(readableOn([250, 220, 0])).toBe('#000000');
    expect(readableOn([20, 30, 90])).toBe('#ffffff');
  });
  it('conversions hex et Lab aller-retour', () => {
    expect(rgbToHex(hexToRgb('#1a2B3c'))).toBe('#1a2b3c');
    expect(hexToRgb('#f80')).toEqual([255, 136, 0]);
    for (const c of ['#e5322d', '#2d6ff0', '#f5d000', '#808080']) expect(rgbToHex(labToRgb(rgbToLab(hexToRgb(c))))).toBe(c);
  });
  it('familles de couleurs', () => {
    expect(colorFamily(hexToRgb('#e5322d'))).toBe('rouge');
    expect(colorFamily(hexToRgb('#f5d000'))).toBe('jaune');
    expect(colorFamily(hexToRgb('#2d6ff0'))).toBe('bleu');
    expect(colorFamily(hexToRgb('#2fb24c'))).toBe('vert');
    expect(colorFamily(hexToRgb('#0a0a0a'))).toBe('noir');
    expect(colorFamily(hexToRgb('#fafafa'))).toBe('blanc');
    expect(colorFamily(hexToRgb('#8e8e93'))).toBe('gris');
    expect(colorFamily(hexToRgb('#6b3e1e'))).toBe('marron');
  });
});
