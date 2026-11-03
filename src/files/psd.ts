// Lecture de l'en-tête d'un fichier Photoshop (.psd / .psb) et de sa miniature JPEG intégrée
// (ressource d'image 1036 « Thumbnail », 1033 pour Photoshop 4). Module pur, testé.

export interface PsdInfo {
  version: 1 | 2;          // 1 = PSD, 2 = PSB (grand format)
  width: number;
  height: number;
  /** Miniature JPEG intégrée (souvent 160 px de large), si présente. */
  thumbnail?: { data: Uint8Array; width: number; height: number; bgr: boolean };
  /** Le tampon est trop court : relire au moins ce nombre d'octets pour atteindre les ressources. */
  needBytes?: number;
}

const ascii = (v: DataView, at: number, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(at + i));
  return s;
};

/** Analyse le début d'un PSD. `null` si ce n'est pas un fichier Photoshop. */
export function parsePsd(buf: ArrayBuffer): PsdInfo | null {
  const v = new DataView(buf);
  if (buf.byteLength < 30 || ascii(v, 0, 4) !== '8BPS') return null;
  const version = v.getUint16(4);
  if (version !== 1 && version !== 2) return null;
  const info: PsdInfo = { version, height: v.getUint32(14), width: v.getUint32(18) };
  // Section « color mode data »
  let off = 26;
  const colorLen = v.getUint32(off); off += 4 + colorLen;
  if (off + 4 > buf.byteLength) { info.needBytes = off + 4; return info; }
  // Section « image resources »
  const resLen = v.getUint32(off); off += 4;
  const end = off + resLen;
  if (end > buf.byteLength) { info.needBytes = end; }
  let fallback: PsdInfo['thumbnail'];
  while (off + 12 <= Math.min(end, buf.byteLength)) {
    const sig = ascii(v, off, 4);
    if (sig !== '8BIM' && sig !== 'MeSa' && sig !== 'AgHg' && sig !== 'PHUT' && sig !== 'DCSR' && sig !== '8B64') break;
    const id = v.getUint16(off + 4);
    const nameLen = v.getUint8(off + 6);
    let p = off + 6 + nameLen + 1; if ((nameLen + 1) % 2) p++;          // nom Pascal, aligné sur 2
    if (p + 4 > buf.byteLength) break;
    const size = v.getUint32(p); p += 4;
    const dataEnd = p + size;
    if ((id === 1036 || id === 1033) && dataEnd <= buf.byteLength && size > 28) {
      const format = v.getUint32(p);
      const tw = v.getUint32(p + 4); const th = v.getUint32(p + 8);
      const compressed = v.getUint32(p + 20);
      const len = Math.min(compressed || size - 28, size - 28);
      if (format === 1 && len > 0) {
        const thumb = { data: new Uint8Array(buf, p + 28, len), width: tw, height: th, bgr: id === 1033 };
        if (id === 1036) { info.thumbnail = thumb; delete info.needBytes; return info; }
        fallback = thumb;
      }
    }
    off = dataEnd + (size % 2);
  }
  if (fallback) { info.thumbnail = fallback; delete info.needBytes; }
  return info;
}
