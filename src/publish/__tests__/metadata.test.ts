import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES, buildDescription, buildVideoResource, effectivePrivacy, fitTags, hasBlocking, hashtags, normalizeTags,
  renderTemplate, resourceParts, sanitizeYtText, tagsLength, unknownVariables, utf8Bytes, validateDraft,
} from '../metadata';
import type { VideoDraft } from '../types';

const base = (over: Partial<VideoDraft> = {}): VideoDraft => ({
  id: 'd1', channelId: 'UC123', title: 'J’ai piraté le Wi-Fi du voisin', description: 'Résumé de la vidéo.', includeChapters: true, includeLinks: true,
  chapters: [{ start: 0, title: 'Intro' }, { start: 45, title: 'Le plan' }, { start: 300, title: 'Le résultat' }],
  tags: ['wifi', 'prank', 'jeu vidéo'], categoryId: '24', defaultLanguage: 'fr', defaultAudioLanguage: 'fr',
  captions: [], playlistIds: [], privacy: 'public', madeForKids: false, containsSyntheticMedia: false, license: 'youtube',
  embeddable: true, publicStatsViewable: true, notifySubscribers: true, updatedAt: 0,
  file: { path: 'C:/v.mp4', name: 'v.mp4', size: 1000, durationSec: 600, width: 1920, height: 1080 },
  ...over,
});
const ctx = { channelId: 'UC123', channelTitle: 'Ma chaîne', links: [{ label: 'Discord', url: 'https://discord.gg/abc' }], playlists: [], lastVideo: { id: 'abcdefghijk', title: 'Ma vidéo précédente' }, date: new Date('2026-11-03T10:00:00Z') };

describe('tags', () => {
  it('compte comme YouTube (exemple de la doc : « Foo Baz » = 9, « Foo-Baz » = 7)', () => {
    expect(tagsLength(['Foo Baz'])).toBe(9);
    expect(tagsLength(['Foo-Baz'])).toBe(7);
    expect(tagsLength(['Foo Baz', 'Foo-Baz'])).toBe(17);
    expect(tagsLength([])).toBe(0);
  });
  it('normalise la saisie', () => {
    expect(normalizeTags('roblox, #Minecraft,  roblox , jeu   vidéo,')).toEqual(['roblox', 'Minecraft', 'jeu vidéo']);
    expect(normalizeTags(['<b>', 'ok'])).toEqual(['b', 'ok']);
  });
  it('coupe à 500 caractères', () => {
    const many = Array.from({ length: 100 }, (_, i) => 'motclef' + i);
    const fit = fitTags(many);
    expect(tagsLength(fit)).toBeLessThanOrEqual(500);
    expect(fit.length).toBeLessThan(many.length);
  });
  it('hashtags', () => expect(hashtags(['jeu vidéo', 'Roblox', 'c++', 'quatre'])).toBe('#jeuvidéo #Roblox #c'));
});

describe('description', () => {
  it('sections conditionnelles et variables', () => {
    expect(renderTemplate('A{{#x}}\n[{{x}}]{{/x}}\nB {{y}}', { x: '', y: 'ok' })).toBe('A\nB ok');
    expect(renderTemplate('{{#x}}<{{x}}>{{/x}}', { x: '1' })).toBe('<1>');
    expect(renderTemplate('{{inconnue}}', {})).toBe('{{inconnue}}');
    expect(unknownVariables('{{chapitres}} {{oups}} {{#liens}}{{/liens}}')).toEqual(['oups']);
  });
  it('template standard : chapitres, abonnement, dernière vidéo, liens, hashtags', () => {
    const d = base({ description: 'Résumé.' + DEFAULT_TEMPLATES[0].body });
    const text = buildDescription(d, ctx);
    expect(text).toContain('Résumé.');
    expect(text).toContain('00:00 Intro\n00:45 Le plan\n05:00 Le résultat');
    expect(text).toContain('https://www.youtube.com/channel/UC123?sub_confirmation=1');
    expect(text).toContain('Ma vidéo précédente — https://youtu.be/abcdefghijk');
    expect(text).toContain('Discord : https://discord.gg/abc');
    expect(text).toContain('#wifi #prank #jeuvidéo');
    expect(text).not.toMatch(/\{\{|\n\n\n/);
  });
  it('ajoute chapitres et liens à la fin s’ils sont activés mais absents du texte', () => {
    const text = buildDescription(base({ description: 'Juste un résumé avec <balise>.' }), ctx);
    expect(text.startsWith('Juste un résumé avec ‹balise›.')).toBe(true);
    expect(text).toContain('\n\n00:00 Intro');
    expect(text.trim().endsWith('Discord : https://discord.gg/abc')).toBe(true);
  });
  it('chapitres invalides ou désactivés : rien n’est inséré', () => {
    expect(buildDescription(base({ includeChapters: false, includeLinks: false, description: 'X {{chapitres}}' }), ctx)).toBe('X');
    expect(buildDescription(base({ chapters: [{ start: 0, title: 'Seul' }], includeLinks: false }), ctx)).toBe('Résumé de la vidéo.');
  });
  it('octets UTF-8', () => { expect(utf8Bytes('é')).toBe(2); expect(sanitizeYtText('a<b>c')).toBe('a‹b›c'); });
});

describe('ressource videos.insert', () => {
  it('publique', () => {
    const r = buildVideoResource(base(), 'desc');
    expect(r).toEqual({
      snippet: { title: 'J’ai piraté le Wi-Fi du voisin', description: 'desc', categoryId: '24', tags: ['wifi', 'prank', 'jeu vidéo'], defaultLanguage: 'fr', defaultAudioLanguage: 'fr' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false, license: 'youtube', embeddable: true, publicStatsViewable: true },
    });
    expect(resourceParts(r)).toBe('snippet,status');
  });
  it('programmée : privée + publishAt ISO, et autres options', () => {
    const r = buildVideoResource(base({ privacy: 'public', scheduleAt: '2026-11-06T16:00:00.000Z', madeForKids: true, containsSyntheticMedia: true, license: 'creativeCommon', embeddable: false, publicStatsViewable: false, recordingDate: '2026-10-30', title: 'A <b> B', tags: [] }), 'd');
    expect(r.status).toEqual({ privacyStatus: 'private', publishAt: '2026-11-06T16:00:00.000Z', selfDeclaredMadeForKids: true, containsSyntheticMedia: true, license: 'creativeCommon', embeddable: false, publicStatsViewable: false });
    expect(r.snippet.title).toBe('A ‹b› B');
    expect(r.snippet.tags).toBeUndefined();
    expect(r.recordingDetails).toEqual({ recordingDate: '2026-10-30T00:00:00.000Z' });
    expect(resourceParts(r)).toBe('snippet,status,recordingDetails');
    expect(effectivePrivacy({ privacy: 'unlisted', scheduleAt: undefined })).toBe('unlisted');
  });
  it('titre tronqué à 100 caractères', () => {
    expect(buildVideoResource(base({ title: 'x'.repeat(150) }), '').snippet.title).toHaveLength(100);
  });
});

describe('validation avant publication', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  it('brouillon complet : aucune erreur bloquante', () => {
    expect(hasBlocking(validateDraft(base(), { now, description: 'ok' }))).toBe(false);
  });
  it('erreurs bloquantes', () => {
    const issues = validateDraft(base({ madeForKids: null, scheduleAt: '2026-11-01T10:00:00Z', title: 'x'.repeat(120), categoryId: '' }), { now, description: 'é'.repeat(2600) });
    const fields = issues.filter(i => i.level === 'error').map(i => i.field);
    expect(fields).toEqual(expect.arrayContaining(['kids', 'schedule', 'title', 'category', 'description']));
  });
  it('programmation trop proche = avertissement', () => {
    const issues = validateDraft(base({ scheduleAt: new Date(now + 5 * 60_000).toISOString() }), { now });
    expect(issues.find(i => i.field === 'schedule')?.level).toBe('warning');
  });
  it('chapitres invalides = avertissement', () => {
    const issues = validateDraft(base({ chapters: [{ start: 0, title: 'A' }, { start: 5, title: 'B' }] }), { now });
    expect(issues.filter(i => i.field === 'chapters').length).toBeGreaterThan(0);
  });
});
