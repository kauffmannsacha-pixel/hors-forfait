import { describe, expect, it } from 'vitest';
import { EXPORT_H, EXPORT_W, exportThumbnail, MAX_EXPORT_BYTES, posterizeData, type ExportCanvas } from '../editor/export';
import { CANVAS_H, CANVAS_W, commit, commitFrom, coverPlacement, crop169At, emptyDoc, historyInit, makeImage, makeText, redo, rubberBand, setCrop, transient, undo } from '../editor/model';

interface FakeCanvas extends ExportCanvas { renders: number; bits?: number }
const MB = 1024 * 1024;
/** Encodeur simulé : la taille dépend du format et de la postérisation (photo très détaillée). */
function deps(sizes: Record<string, number>, log: FakeCanvas[] = []) {
  return {
    createCanvas: (w: number, h: number): FakeCanvas => { const c = { width: w, height: h, renders: 0 }; log.push(c); return c; },
    render: (c: FakeCanvas) => { c.renders++; },
    posterize: (c: FakeCanvas, bits: number) => { c.bits = bits; },
    encode: async (c: FakeCanvas, type: 'image/png' | 'image/jpeg', q?: number) => {
      const key = type === 'image/png' ? `png${c.bits ? '-' + c.bits : ''}` : `jpeg-${Math.round((q ?? 1) * 100)}`;
      return new Blob([new Uint8Array(sizes[key] ?? 10)], { type });
    },
  };
}

describe('export 1280×720 < 2 Mo', () => {
  it('exporte en PNG 1280×720 directement si léger', async () => {
    const log: FakeCanvas[] = [];
    const r = await exportThumbnail(deps({ png: 900_000 }, log));
    expect([r.width, r.height]).toEqual([1280, 720]);
    expect([EXPORT_W, EXPORT_H]).toEqual([CANVAS_W, CANVAS_H]);
    expect(r.type).toBe('image/png'); expect(r.step).toBe('png');
    expect(r.blob.size).toBeLessThan(MAX_EXPORT_BYTES);
    expect(log.every(c => c.width === 1280 && c.height === 720 && c.renders === 1)).toBe(true);
  });
  it('postérise le PNG quand il dépasse 2 Mo, en restant en 1280×720', async () => {
    const log: FakeCanvas[] = [];
    const r = await exportThumbnail(deps({ png: 3.1 * MB, 'png-6': 2.3 * MB, 'png-5': 1.6 * MB }, log));
    expect(r.step).toBe('png-5bits'); expect(r.type).toBe('image/png');
    expect(r.blob.size).toBeLessThan(2 * MB);
    expect(r.attempts.map(a => a.step)).toEqual(['png', 'png-6bits', 'png-5bits']);
    expect(log).toHaveLength(3);
    expect(log.every(c => c.width === 1280 && c.height === 720)).toBe(true);
  });
  it('repli JPEG si aucun PNG ne passe, et erreur si rien ne passe', async () => {
    const big = { png: 5 * MB, 'png-6': 4 * MB, 'png-5': 3 * MB, 'png-4': 2.5 * MB };
    const r = await exportThumbnail(deps({ ...big, 'jpeg-92': 2.2 * MB, 'jpeg-85': 1.1 * MB }));
    expect(r.type).toBe('image/jpeg'); expect(r.step).toBe('jpeg-85');
    expect([r.width, r.height]).toEqual([1280, 720]);
    await expect(exportThumbnail(deps({ ...big, 'jpeg-92': 3 * MB, 'jpeg-85': 3 * MB, 'jpeg-75': 3 * MB, 'jpeg-60': 3 * MB }))).rejects.toThrow(/2 Mo/);
  });
  it('refuse un canvas aux mauvaises dimensions', async () => {
    const d = deps({ png: 10 });
    await expect(exportThumbnail({ ...d, createCanvas: () => ({ width: 1920, height: 1080, renders: 0 }) })).rejects.toThrow(/1920×1080/);
  });
  it('postérisation : 2^bits niveaux par canal, alpha intact', () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v < 256; v++) data.set([v, 255 - v, v, 77], v * 4);
    posterizeData(data, 4);
    const levels = new Set<number>(); for (let i = 0; i < data.length; i += 4) { levels.add(data[i]); expect(data[i + 3]).toBe(77); }
    expect(levels.size).toBe(16);
    expect(Math.min(...levels)).toBe(0); expect(Math.max(...levels)).toBe(255);
  });
});

describe('modèle de l’éditeur', () => {
  it('une image importée remplit le cadre 1280×720 avec un recadrage 16:9', () => {
    const p = coverPlacement(4000, 3000);
    expect(p.crop.w / p.crop.h).toBeCloseTo(16 / 9, 6);
    expect(p.crop.w * p.scale).toBeCloseTo(1280, 6);
    expect(p.crop.h * p.scale).toBeCloseTo(720, 6);
    const img = makeImage({ kind: 'memory', key: 'k', name: 'photo' }, 1080, 1920);
    const c = crop169At(1080, 1920, 0.5, 540, 200);
    expect(c.w / c.h).toBeCloseTo(16 / 9, 6);
    expect(c.y).toBeGreaterThanOrEqual(0);
    const cropped = setCrop(img, c);
    expect(cropped.crop.w * cropped.scale).toBeCloseTo(img.crop.w * img.scale, 6); // taille affichée conservée
  });
  it('élastique aux bords : résistance croissante, jamais au-delà de la dimension', () => {
    expect(rubberBand(500, 0, 1280, 300)).toBe(500);
    const a = rubberBand(1380, 0, 1280, 300), b = rubberBand(1680, 0, 1280, 300);
    expect(a).toBeGreaterThan(1280); expect(a).toBeLessThan(1380);
    expect(b - 1280).toBeLessThan(300);
    expect(b - a).toBeLessThan(a - 1280 + 300);
    expect(rubberBand(-100, 0, 1280, 300)).toBeLessThan(0);
  });
  it('annuler / rétablir, fusion des réglages successifs, geste en une seule entrée', () => {
    const t = makeText('A');
    let h = historyInit({ ...emptyDoc(), layers: [t] });
    const d1 = { ...h.present, layers: [{ ...t, size: 120 }] };
    h = commit(h, d1, 'size', 1000);
    h = commit(h, { ...h.present, layers: [{ ...t, size: 110 }] }, 'size', 1300); // fusionné
    expect(h.past).toHaveLength(1);
    const before = h.present;
    h = transient(h, { ...h.present, layers: [{ ...t, size: 110, x: 10 }] });
    h = transient(h, { ...h.present, layers: [{ ...t, size: 110, x: 20 }] });
    h = commitFrom(h, before, h.present);
    expect(h.past).toHaveLength(2);
    h = undo(h); expect((h.present.layers[0] as typeof t).x).toBe(t.x);
    h = undo(h); expect((h.present.layers[0] as typeof t).size).toBe(t.size);
    h = redo(h); h = redo(h); expect((h.present.layers[0] as typeof t).x).toBe(20);
  });
});
