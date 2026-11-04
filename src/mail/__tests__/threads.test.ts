import { describe, expect, it } from 'vitest';
import { groupThreads, participantLabel } from '../threads';
import type { MailHeader } from '../types';
import { normalizeSubject } from '../util';

let n = 0;
function h(p: Partial<MailHeader>): MailHeader {
  n++;
  return {
    key: p.key ?? `acc|INBOX|${n}`, accountId: p.accountId ?? 'acc', providerId: String(n), folder: p.folder ?? 'INBOX',
    subject: 'Sujet', from: { email: 'a@x.fr' }, to: [], cc: [], date: n * 1000, snippet: '', unread: false, starred: false,
    hasAttachments: false, ...p,
  };
}

describe('regroupement en fils', () => {
  it('regroupe par threadId Gmail', () => {
    const t = groupThreads([
      h({ threadId: 'T1', subject: 'Hello', date: 1 }),
      h({ threadId: 'T1', subject: 'Re: Hello', date: 5, unread: true }),
      h({ threadId: 'T2', subject: 'Autre', date: 3 }),
    ]);
    expect(t).toHaveLength(2);
    expect(t[0].key).toBe('acc|t|T1');
    expect(t[0].messages).toHaveLength(2);
    expect(t[0].unread).toBe(1);
    expect(t[0].subject).toBe('Hello');
  });

  it('suit la chaîne References / In-Reply-To (IMAP), même dans le désordre', () => {
    const c = h({ messageId: 'c@x', inReplyTo: 'b@x', references: ['b@x'], subject: 'Re: Projet', date: 30 });
    const a = h({ messageId: 'a@x', subject: 'Projet', date: 10 });
    const b = h({ messageId: 'b@x', inReplyTo: 'a@x', references: ['a@x'], subject: 'Re: Projet', date: 20, folder: 'Sent', key: 'acc|Sent|9' });
    const other = h({ messageId: 'z@x', subject: 'Projet', date: 40 });
    const t = groupThreads([c, other, a, b]);
    const proj = t.find(x => x.messages.some(m => m.messageId === 'a@x'))!;
    expect(proj.messages.map(m => m.messageId)).toEqual(['a@x', 'b@x', 'c@x']);
    expect(proj.key).toBe('acc|r|a@x');
    // un nouveau message sans « Re: » ni référence reste un fil séparé
    expect(t.find(x => x.messages.some(m => m.messageId === 'z@x'))!.messages).toHaveLength(1);
  });

  it('rattache une réponse « RE: » sans en-têtes de référence par sujet', () => {
    const t = groupThreads([
      h({ messageId: 'p@x', subject: 'Devis tournage', date: 1000 }),
      h({ messageId: 'q@x', subject: 'RE: Devis tournage', date: 2000 }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].messages).toHaveLength(2);
  });

  it('ne mélange pas les comptes et fusionne les doublons (même Message-ID)', () => {
    const t = groupThreads([
      h({ accountId: 'a1', key: 'a1|INBOX|1', messageId: 'm@x' }),
      h({ accountId: 'a1', key: 'a1|Archive|7', folder: 'Archive', messageId: 'm@x' }),
      h({ accountId: 'a2', key: 'a2|INBOX|1', messageId: 'm@x' }),
    ]);
    expect(t).toHaveLength(2);
    expect(t.find(x => x.accountId === 'a1')!.messages).toHaveLength(1);
  });

  it('trie les fils du plus récent au plus ancien', () => {
    const t = groupThreads([h({ threadId: 'A', date: 1 }), h({ threadId: 'B', date: 9 }), h({ threadId: 'A', date: 5 })]);
    expect(t.map(x => x.key)).toEqual(['acc|t|B', 'acc|t|A']);
    expect(t[1].lastDate).toBe(5);
  });

  it('libellé des participants', () => {
    const [t] = groupThreads([
      h({ threadId: 'X', from: { name: 'Léa Martin', email: 'lea@x.fr' } }),
      h({ threadId: 'X', from: { email: 'moi@x.fr' } }),
    ]);
    expect(participantLabel(t, ['moi@x.fr'])).toBe('Léa, Moi');
  });

  it('normalise les sujets', () => {
    expect(normalizeSubject('RE: Fwd: TR : Re[2]: Facture mars')).toBe('Facture mars');
    expect(normalizeSubject('[EXT] Re: Collab')).toBe('Collab');
  });
});
