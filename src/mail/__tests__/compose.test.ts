import { describe, expect, it } from 'vitest';
import { buildForwardHtml, buildReferences, buildReplyQuoteHtml, composeHtml, forwardSubject, htmlToText, quoteText, replyRecipients, replySubject, stripQuotedText, textToHtml, type QuoteSource } from '../compose';
import { buildMime, encodeWord, toGmailRaw } from '../mime';
import { base64ToUtf8, parseAddressList } from '../util';

const src: QuoteSource = {
  from: { name: 'Nike France', email: 'deals@nike.fr' },
  to: [{ email: 'moi@chaine.fr' }, { name: 'Agent', email: 'agent@agence.fr' }],
  cc: [{ email: 'compta@nike.fr' }, { email: 'MOI@chaine.fr' }],
  date: new Date(2026, 10, 3, 14, 5).getTime(),
  subject: 'Re: Partenariat été',
  messageId: 'orig@nike.fr',
  references: ['root@nike.fr'],
  text: 'Bonjour,\nVoici notre offre.',
  safeHtml: '<p>Bonjour,<br>Voici notre <b>offre</b>.</p>',
};

describe('réponse / transfert', () => {
  it('préfixes de sujet sans doublon', () => {
    expect(replySubject(src.subject)).toBe('Re: Partenariat été');
    expect(forwardSubject('Fwd: Re: Devis')).toBe('Fwd: Devis');
  });

  it('destinataires : répondre / répondre à tous (sans moi, sans doublons)', () => {
    const me = ['moi@chaine.fr'];
    expect(replyRecipients(src, me, 'reply')).toEqual({ to: [src.from], cc: [] });
    const all = replyRecipients(src, me, 'replyAll');
    expect(all.to.map(a => a.email)).toEqual(['deals@nike.fr', 'agent@agence.fr']);
    expect(all.cc.map(a => a.email)).toEqual(['compta@nike.fr']);
    // Reply-To prioritaire
    expect(replyRecipients({ ...src, replyTo: [{ email: 'repondre@nike.fr' }] }, me, 'reply').to[0].email).toBe('repondre@nike.fr');
    // réponse à mon propre message → destinataires d'origine
    expect(replyRecipients({ ...src, from: { email: 'moi@chaine.fr' } }, me, 'reply').to.map(a => a.email)).toEqual(['agent@agence.fr']);
  });

  it('chaîne References = références d’origine + Message-ID', () => {
    expect(buildReferences(src)).toEqual(['root@nike.fr', 'orig@nike.fr']);
    const many = { references: Array.from({ length: 30 }, (_, i) => `r${i}@x`), messageId: 'last@x' };
    const r = buildReferences(many);
    expect(r).toHaveLength(20);
    expect(r[0]).toBe('r0@x');
    expect(r[19]).toBe('last@x');
  });

  it('citation HTML (« Le … a écrit : » + blockquote)', () => {
    const q = buildReplyQuoteHtml(src);
    expect(q).toContain('a écrit :');
    expect(q).toContain('Nike France &lt;deals@nike.fr&gt;');
    expect(q).toContain('<blockquote type="cite"');
    expect(q).toContain('<b>offre</b>');
    const html = composeHtml('<p>Merci !</p>', q);
    expect(html.indexOf('Merci')).toBeLessThan(html.indexOf('blockquote'));
    // repli texte quand pas de HTML
    expect(buildReplyQuoteHtml({ ...src, safeHtml: undefined })).toContain('Bonjour,<br>Voici notre offre.');
  });

  it('citation texte et transfert', () => {
    expect(quoteText(src).split('\n').slice(1)).toEqual(['> Bonjour,', '> Voici notre offre.']);
    const f = buildForwardHtml(src);
    expect(f).toContain('Message transféré');
    expect(f).toContain('Objet : Re: Partenariat été');
    expect(f).toContain('Cc : compta@nike.fr');
  });
});

describe('conversions', () => {
  it('HTML → texte', () => {
    const t = htmlToText('<style>p{}</style><h1>Titre</h1><p>Un <a href="https://x.fr/a">lien</a></p><ul><li>un</li><li>deux</li></ul><blockquote>cité</blockquote>');
    expect(t).toContain('Titre');
    expect(t).toContain('Un lien (https://x.fr/a)');
    expect(t).toContain('- un\n- deux');
    expect(t).toContain('> cité');
    expect(t).not.toContain('p{}');
  });
  it('texte → HTML échappé avec liens', () => {
    expect(textToHtml('a <b>\nhttps://x.fr\n\nfin')).toBe('<p>a &lt;b&gt;<br><a href="https://x.fr">https://x.fr</a></p><p>fin</p>');
  });
  it('retire les citations', () => {
    expect(stripQuotedText('Super, merci !\n\nLe lun. 3 nov. 2026 à 14:05, Nike <a@b.fr> a écrit :\n> blabla')).toBe('Super, merci !');
    expect(stripQuotedText('Ok pour moi\n\nDe : Jean\nEnvoyé : lundi\nObjet : x\n\nancien')).toBe('Ok pour moi');
    expect(stripQuotedText('On Mon, Nov 3, 2026 at 2:05 PM Bob <b@x.com>\nwrote:\n> hi')).toBe('');
  });
  it('liste d’adresses RFC 5322', () => {
    expect(parseAddressList('"Martin, Léa" <lea@x.fr>, bob@y.com; Zoé <z@z.fr>')).toEqual([
      { name: 'Martin, Léa', email: 'lea@x.fr' }, { email: 'bob@y.com' }, { name: 'Zoé', email: 'z@z.fr' },
    ]);
  });
});

describe('construction MIME', () => {
  const mime = buildMime({
    from: { name: 'Créateur', email: 'moi@chaine.fr' },
    to: [{ name: 'Nike France', email: 'deals@nike.fr' }],
    cc: [{ email: 'agent@agence.fr' }],
    subject: 'Re: Partenariat été ☀️',
    text: 'Merci !',
    html: '<p>Merci !</p>',
    inReplyTo: 'orig@nike.fr',
    references: ['root@nike.fr', 'orig@nike.fr'],
    date: new Date(Date.UTC(2026, 10, 3, 13, 5, 0)),
    boundarySeed: 'test',
    attachments: [{ name: 'Brief été.pdf', mime: 'application/pdf', data: btoa('%PDF-1.4 contenu') }],
  });

  it('en-têtes encodés RFC 2047 et fil de réponse', () => {
    expect(mime).toContain('From: =?UTF-8?B?');
    expect(mime).toContain('To: Nike France <deals@nike.fr>');
    expect(mime).toContain('Cc: agent@agence.fr');
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(mime).toContain('In-Reply-To: <orig@nike.fr>');
    expect(mime).toContain('References: <root@nike.fr>\r\n <orig@nike.fr>');
    expect(mime).toContain('MIME-Version: 1.0');
    const subj = /Subject: ((?:=\?UTF-8\?B\?[^?]+\?=(?:\r\n )?)+)/.exec(mime)![1];
    const decoded = subj.split(/\r\n /).map(w => base64ToUtf8(/=\?UTF-8\?B\?([^?]+)\?=/.exec(w)![1])).join('');
    expect(decoded).toBe('Re: Partenariat été ☀️');
  });

  it('structure multipart mixed > alternative (texte + HTML) + pièce jointe', () => {
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="=_Prisme_test_2"');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="=_Prisme_test_1"');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toContain("filename*=UTF-8''Brief%20%C3%A9t%C3%A9.pdf");
    expect(mime).toContain('--=_Prisme_test_2--');
    for (const line of mime.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  it('corps base64 décodable et sortie base64url pour Gmail', () => {
    const htmlB64 = /text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(mime)![1];
    expect(base64ToUtf8(htmlB64.replace(/\r\n/g, ''))).toBe('<p>Merci !</p>');
    const raw = toGmailRaw(mime);
    expect(raw).not.toMatch(/[+/=]/);
    expect(base64ToUtf8(raw)).toBe(mime);
  });

  it('mots encodés coupés sans casser les caractères', () => {
    const long = 'é'.repeat(60);
    const words = encodeWord(long).split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    expect(words.map(w => base64ToUtf8(/\?B\?(.+)\?=/.exec(w)![1])).join('')).toBe(long);
  });
});
