import { describe, expect, it } from 'vitest';
import { buildFrameDoc, cleanCss, sanitizeMailHtml, sanitizePlainText } from '../sanitize';
import { decodeEntities, gmailBody, gmailToHeader } from '../gmailParse';
import { guessRole, sortFolders } from '../folders';

const html = `<html><head><style>@import url(https://evil.example/x.css); .a{background:url(https://track.example/bg.png)} </style></head>
<body bgcolor="#fafafa"><p onclick="alert(1)">Bonjour <a href="javascript:alert(1)">piège</a> <a href="https://site.fr">site</a></p>
<script>alert(1)</script><iframe src="https://x"></iframe><form action="https://x"><input name="pwd"></form>
<img src="https://track.example/pixel.gif" width="1" height="1"><img src="https://cdn.example/logo.png" alt="logo" width="120">
<img src="cid:image001.png@01D" alt="inline"><div style="background-image:url('https://cdn.example/a.jpg');color:red">x</div>
<table background="https://cdn.example/t.jpg"><tr><td>t</td></tr></table></body></html>`;

describe('nettoyage HTML', () => {
  it('retire scripts, iframes, formulaires, gestionnaires et liens javascript:', () => {
    const r = sanitizeMailHtml(html, { allowRemote: false });
    expect(r.html).not.toMatch(/<script|<iframe|<form|<input|onclick|javascript:/i);
    expect(r.html).toContain('href="https://site.fr"');
    expect(r.html).toContain('target="_blank"');
    expect(r.html).toContain('rel="noopener noreferrer"');
    expect(r.css).not.toContain('@import');
  });

  it('bloque les contenus distants par défaut (images, fonds, CSS) et supprime les pixels espions', () => {
    const r = sanitizeMailHtml(html, { allowRemote: false });
    expect(r.hasRemote).toBe(true);
    expect(r.blocked).toBeGreaterThanOrEqual(5);
    expect(r.html).not.toMatch(/\ssrc="https:/);
    expect(r.html).toContain('data-prisme-src="https://cdn.example/logo.png"');
    expect(r.html).toContain('prisme-blocked');
    expect(r.html).not.toContain('pixel.gif');
    expect(r.html).not.toContain('background="https://');
    expect(r.html).not.toContain("url('https://cdn.example/a.jpg')");
    expect(r.css).not.toContain('track.example');
    expect(r.background).toBe('#fafafa');
  });

  it('affiche les images distantes après autorisation', () => {
    const r = sanitizeMailHtml(html, { allowRemote: true });
    expect(r.blocked).toBe(0);
    expect(r.html).toContain('src="https://cdn.example/logo.png"');
    expect(r.html).not.toContain('pixel.gif');
    expect(r.css).toContain('url("https://track.example/bg.png")');
  });

  it('remplace les images intégrées cid: par leurs données', () => {
    const r = sanitizeMailHtml(html, { allowRemote: false, cid: { 'image001.png@01d': 'data:image/png;base64,AAAA' } });
    expect(r.html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('CSS : neutralise expression(), bindings et sortie de balise', () => {
    const c = cleanCss('a{width:expression(alert(1));-moz-binding:url(x)} </style><script>', false);
    expect(c.css).not.toMatch(/expression\(|-moz-binding|<\/style|<script/i);
  });

  it('document de l’iframe : CSP stricte sans scripts', () => {
    const doc = buildFrameDoc(sanitizeMailHtml('<p>hi</p>', { allowRemote: false }), { allowRemote: false, dark: false, plain: false });
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('img-src data: blob:;');
    expect(doc).not.toContain('script-src');
    const allowed = buildFrameDoc(sanitizeMailHtml('<p>hi</p>', { allowRemote: true }), { allowRemote: true, dark: false, plain: false });
    expect(allowed).toContain('img-src data: blob: https: http:');
  });

  it('texte brut : échappé', () => {
    expect(sanitizePlainText('<script>x</script> salut').html).toContain('&lt;script&gt;');
  });
});

describe('Gmail et dossiers', () => {
  const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const msg = {
    id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD', 'STARRED'], snippet: 'L&#39;offre &amp; le brief', internalDate: '1762171500000',
    payload: {
      mimeType: 'multipart/mixed', headers: [
        { name: 'From', value: '"Nike, FR" <deals@nike.fr>' }, { name: 'To', value: 'moi@chaine.fr' }, { name: 'Subject', value: 'Offre été' },
        { name: 'Message-ID', value: '<abc@nike.fr>' }, { name: 'References', value: '<r1@x> <r2@x>' },
      ],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { size: 5, data: b64url('Salut été') } },
          { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }], body: { size: 5, data: b64url('<p>Salut été</p>') } },
        ] },
        { mimeType: 'application/pdf', filename: 'brief.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="brief.pdf"' }], body: { size: 1234, attachmentId: 'ATT1' } },
      ],
    },
  };
  it('convertit un message Gmail', () => {
    const h = gmailToHeader('acc', msg, 'INBOX');
    expect(h).toMatchObject({ key: 'acc|m1', threadId: 't1', unread: true, starred: true, hasAttachments: true, subject: 'Offre été', messageId: 'abc@nike.fr', references: ['r1@x', 'r2@x'] });
    expect(h.from).toEqual({ name: 'Nike, FR', email: 'deals@nike.fr' });
    expect(h.snippet).toBe("L'offre & le brief");
    const b = gmailBody(msg);
    expect(b.text).toBe('Salut été');
    expect(b.html).toBe('<p>Salut été</p>');
    expect(b.attachments).toEqual([{ id: 'ATT1', name: 'brief.pdf', mime: 'application/pdf', size: 1234, contentId: undefined, inline: false, data: undefined }]);
    expect(decodeEntities('&lt;b&gt; &#x27;ok&#x27;')).toBe("<b> 'ok'");
  });
  it('rôles et tri des dossiers IMAP', () => {
    expect(guessRole('INBOX', 'INBOX')).toBe('inbox');
    expect(guessRole('Éléments envoyés', 'Éléments envoyés')).toBe('sent');
    expect(guessRole('Courrier indésirable', 'Courrier indésirable')).toBe('junk');
    expect(guessRole('Clients', 'Clients')).toBeUndefined();
    const sorted = sortFolders([
      { accountId: 'a', id: 'Clients', name: 'Clients', selectable: true, depth: 0 },
      { accountId: 'a', id: 'Trash', name: 'Trash', role: 'trash', selectable: true, depth: 0 },
      { accountId: 'a', id: 'INBOX/Pro', name: 'Pro', selectable: true, depth: 1 },
      { accountId: 'a', id: 'INBOX', name: 'Réception', role: 'inbox', selectable: true, depth: 0 },
      { accountId: 'a', id: 'Sent', name: 'Sent', role: 'sent', selectable: true, depth: 0 },
    ]);
    expect(sorted.map(f => f.id)).toEqual(['INBOX', 'INBOX/Pro', 'Sent', 'Trash', 'Clients']);
  });
});
