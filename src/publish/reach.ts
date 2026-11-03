// Rapport « Portée » de la YouTube Reporting API (channel_reach_basic_a1) — analyse CSV pure.
// Colonnes : date (AAAAMMJJ), channel_id, video_id, video_thumbnail_impressions, video_thumbnail_impressions_ctr.

export interface ReachRow { date: string /* AAAA-MM-JJ */; videoId: string; impressions: number; ctr: number /* 0..1 */ }

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export const normDate = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d.slice(0, 10));

/** Lignes du rapport pour les vidéos demandées (toutes si `videoIds` absent). Le CTR est ramené en fraction. */
export function parseReachCsv(text: string, videoIds?: Set<string>): ReachRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = splitCsvLine(lines[0]).map(h => h.trim());
  const iDate = head.indexOf('date'), iVid = head.indexOf('video_id');
  const iImp = head.indexOf('video_thumbnail_impressions'), iCtr = head.indexOf('video_thumbnail_impressions_ctr');
  if (iDate < 0 || iVid < 0 || iImp < 0 || iCtr < 0) return [];
  const rows: ReachRow[] = [];
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l);
    const videoId = c[iVid]?.trim();
    if (!videoId || (videoIds && !videoIds.has(videoId))) continue;
    const impressions = Number(c[iImp]); const ctrRaw = Number(c[iCtr]);
    if (!Number.isFinite(impressions)) continue;
    rows.push({ date: normDate(c[iDate].trim()), videoId, impressions, ctr: Number.isFinite(ctrRaw) ? ctrRaw : 0 });
  }
  // Le CTR est documenté comme un taux ; certains rapports l'expriment en pourcentage (4,5 au lieu de 0,045).
  if (rows.some(r => r.ctr > 1)) for (const r of rows) r.ctr = r.ctr / 100;
  return rows;
}

/** Fusionne plusieurs lignes d'une même vidéo et d'un même jour (somme des impressions, CTR pondéré). */
export function mergeReach(rows: ReachRow[]): Map<string, { impressions: number; ctr: number }> {
  const acc = new Map<string, { impressions: number; clicks: number }>();
  for (const r of rows) {
    const k = `${r.videoId}|${r.date}`;
    const a = acc.get(k) ?? { impressions: 0, clicks: 0 };
    a.impressions += r.impressions; a.clicks += r.impressions * r.ctr;
    acc.set(k, a);
  }
  return new Map([...acc].map(([k, a]) => [k, { impressions: a.impressions, ctr: a.impressions > 0 ? a.clicks / a.impressions : 0 }]));
}
