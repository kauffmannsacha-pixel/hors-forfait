import { describe, expect, it } from 'vitest';
import { buildTriagePrompt, chunk, DEFAULT_CATEGORIES, normalizeCategory, normalizeUrgent, parseTriageResponse, triageKey } from '../categories';

const ids = ['1', '2', '3'];

describe('tri par catégories', () => {
  it('normalise les noms de catégories (accents, synonymes, pluriels)', () => {
    expect(normalizeCategory('Sponsors')).toBe('sponsors');
    expect(normalizeCategory('partenariat')).toBe('sponsors');
    expect(normalizeCategory('Facture')).toBe('factures');
    expect(normalizeCategory('Reçu')).toBe('factures');
    expect(normalizeCategory('collaboration')).toBe('collabs');
    expect(normalizeCategory('Abonnés')).toBe('fans');
    expect(normalizeCategory('Sponsor / marque')).toBe('sponsors');
    expect(normalizeCategory('n’importe quoi')).toBe('autre');
    expect(normalizeCategory(undefined)).toBe('autre');
  });

  it('normalise l’urgence', () => {
    expect(normalizeUrgent(true)).toBe(true);
    expect(normalizeUrgent('oui')).toBe(true);
    expect(normalizeUrgent('Non')).toBe(false);
    expect(normalizeUrgent(1)).toBe(true);
    expect(normalizeUrgent(null)).toBe(false);
  });

  it('analyse une réponse JSON en bloc markdown', () => {
    const raw = '```json\n[{"id":"1","category":"Sponsors","urgent":"oui","reason":"offre Nike, réponse avant vendredi"},{"id":"2","category":"factures","urgent":false},{"id":"3","category":"spam","urgent":false}]\n```';
    const r = parseTriageResponse(raw, DEFAULT_CATEGORIES, ids, 42);
    expect(r['1']).toEqual({ category: 'sponsors', urgent: true, reason: 'offre Nike, réponse avant vendredi', at: 42 });
    expect(r['2'].category).toBe('factures');
    expect(r['3'].category).toBe('autre');
  });

  it('tolère texte autour, objet { results }, ids inconnus et ordre positionnel', () => {
    const r1 = parseTriageResponse('Voici : {"results":[{"id":"2","categorie":"fans","urgence":true}]} fin', DEFAULT_CATEGORIES, ids);
    expect(r1['2']).toMatchObject({ category: 'fans', urgent: true });
    const r2 = parseTriageResponse([{ id: 'x', category: 'collab' }, { category: 'autre' }, { id: '99', category: 'sponsors' }], DEFAULT_CATEGORIES, ids);
    expect(Object.keys(r2).sort()).toEqual(['1', '2', '3']);
    expect(r2['1'].category).toBe('collabs');
    const r3 = parseTriageResponse([{ id: '42', category: 'sponsors' }], DEFAULT_CATEGORIES, ids);
    expect(r3).toEqual({});
    expect(parseTriageResponse('pas du json', DEFAULT_CATEGORIES, ids)).toEqual({});
  });

  it('accepte une map { id: {...} } et des catégories personnalisées', () => {
    const cats = [...DEFAULT_CATEGORIES, { id: 'presse', name: 'Presse', color: '#000', description: 'journalistes' }];
    const r = parseTriageResponse({ '1': { category: 'Presse', urgent: false } }, cats, ids);
    expect(r['1'].category).toBe('presse');
  });

  it('construit le prompt et découpe en lots', () => {
    const p = buildTriagePrompt([{ id: '1', from: 'a', subject: 's', snippet: 'x', date: 'd' }], DEFAULT_CATEGORIES);
    expect(p).toContain('"sponsors" (Sponsors)');
    expect(p).toContain('"id":"1"');
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(triageKey({ key: 'k', messageId: 'ABC@x' })).toBe('mid:abc@x');
    expect(triageKey({ key: 'k' })).toBe('k');
  });
});
