// Fournisseurs de transcription conformes aux CGU YouTube (aucun scraping de timedtext) :
// 1) API officielle captions.list + captions.download pour MES vidéos ; 2) outil MCP « …transcript… » de l'utilisateur ;
// 3) import manuel (.srt / .vtt / .txt / texte collé).
import { youtube } from '../../connectors/api';
import { listMcpTools, callMcpTool, type McpToolInfo } from '../../claude/mcpApi';
import { httpFetch, httpError } from '../../db/http';
import type { Transcript } from '../api';
import type { TranscriptProvider } from './chain';
import { normalizeTranscriptPayload, parseSrt, payloadError } from './parse';

export const CAPTION_COST = { list: 50, download: 200, video: 1 } as const;

interface CaptionTrack { id: string; snippet?: { language?: string; trackKind?: string; status?: string; isDraft?: boolean; name?: string } }

/** Piste préférée : publiée, manuelle avant automatique (ASR), langue souhaitée. */
export function pickCaptionTrack(items: CaptionTrack[], lang?: string): CaptionTrack | null {
  const usable = items.filter(i => i.id && !i.snippet?.isDraft && (i.snippet?.status ?? 'serving') !== 'failed');
  if (!usable.length) return null;
  const score = (i: CaptionTrack) =>
    (i.snippet?.status === 'serving' ? 4 : 0) +
    ((i.snippet?.trackKind ?? '').toLowerCase() === 'asr' ? 0 : 2) +
    (lang && (i.snippet?.language ?? '').toLowerCase().startsWith(lang.toLowerCase()) ? 1 : 0);
  return usable.slice().sort((a, b) => score(b) - score(a))[0];
}

let myChannelsCache: { at: number; ids: string[] } | null = null;
async function myChannelIds(): Promise<string[]> {
  if (myChannelsCache && Date.now() - myChannelsCache.at < 5 * 60_000) return myChannelsCache.ids;
  const ids = (await youtube.channels().catch(() => [])).map(c => c.id);
  myChannelsCache = { at: Date.now(), ids };
  return ids;
}

async function downloadCaption(trackId: string, channelId: string): Promise<string> {
  // captions.download renvoie le fichier brut (SRT) et non du JSON.
  try {
    const r = await youtube.data<unknown>(`captions/${encodeURIComponent(trackId)}`, { tfmt: 'srt' }, { channelId });
    if (typeof r === 'string' && r.includes('-->')) return r;
    if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      for (const k of ['text', 'body', 'data', 'content']) if (typeof o[k] === 'string' && (o[k] as string).includes('-->')) return o[k] as string;
    }
  } catch (e) {
    // Une erreur d'API (403, 404…) est définitive ; une erreur de décodage JSON signifie que le SRT est arrivé mais n'a pas été lu.
    if (!/json|unexpected token|parse/i.test((e as Error)?.message ?? '')) throw e;
  }
  const token = await youtube.token(channelId);
  const res = await httpFetch(`https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(trackId)}?tfmt=srt`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await httpError('YouTube (sous-titres)', res);
  return res.text();
}

/** 1) Sous-titres officiels de mes vidéos (OAuth de la chaîne propriétaire). */
export function youtubeCaptionsProvider(preferredLang = 'fr'): TranscriptProvider {
  return {
    id: 'youtube-captions',
    label: 'Sous-titres officiels (mes chaînes)',
    async fetch(videoId, ctx) {
      const mine = await myChannelIds();
      if (!mine.length) return null;
      let channelId = ctx.channelId;
      if (!channelId) {
        await ctx.beforeCall?.(CAPTION_COST.video, 'videos.list');
        channelId = (await youtube.videos([videoId]))[0]?.channelId;
      }
      if (!channelId || !mine.includes(channelId)) return null; // pas une de mes vidéos : l'API ne permet pas le téléchargement
      await ctx.beforeCall?.(CAPTION_COST.list, 'captions.list');
      const list = await youtube.data<{ items?: CaptionTrack[] }>('captions', { part: 'snippet', videoId }, { channelId });
      const track = pickCaptionTrack(list.items ?? [], preferredLang);
      if (!track) return null;
      await ctx.beforeCall?.(CAPTION_COST.download, 'captions.download');
      const segments = parseSrt(await downloadCaption(track.id, channelId));
      return segments.length ? { videoId, provider: 'youtube-captions', language: track.snippet?.language, segments, timed: true } : null;
    },
  };
}

/** Outil MCP de transcription le plus adapté (nom contenant « transcript »). */
export function pickTranscriptTool(tools: McpToolInfo[]): McpToolInfo | null {
  const cands = tools.filter(t => /transcript/i.test(t.name));
  if (!cands.length) return null;
  const score = (t: McpToolInfo) =>
    (/youtube|tube|yt/i.test(t.name + ' ' + t.server) ? 2 : 0) + (/video/i.test(t.name) ? 1 : 0) - (/search|list|batch/i.test(t.name) ? 2 : 0);
  return cands.slice().sort((a, b) => score(b) - score(a))[0];
}

/** Arguments d'appel selon le schéma d'entrée de l'outil (ID ou URL). */
export function buildTranscriptArgs(tool: McpToolInfo, videoId: string): Record<string, unknown> {
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  const keys = Object.keys(schema.properties ?? {});
  const prefer = ['video_id', 'videoId', 'videoID', 'video', 'id', 'video_url', 'videoUrl', 'url', 'youtube_url', 'youtubeUrl', 'link', 'input', 'query'];
  const key = prefer.find(k => keys.includes(k))
    ?? keys.find(k => /video|url|link|id/i.test(k))
    ?? schema.required?.[0]
    ?? keys[0]
    ?? 'video_id';
  return { [key]: /url|link/i.test(key) ? `https://www.youtube.com/watch?v=${videoId}` : videoId };
}

let toolCache: { at: number; tool: McpToolInfo | null } | null = null;
export async function findTranscriptTool(force = false): Promise<McpToolInfo | null> {
  if (!force && toolCache && Date.now() - toolCache.at < 10 * 60_000) return toolCache.tool;
  const tool = pickTranscriptTool(await listMcpTools().catch(() => []));
  toolCache = { at: Date.now(), tool };
  return tool;
}

/** 2) Outil MCP « transcript » de l'utilisateur (ex. TubeAlfred configuré dans Claude Desktop). */
export function mcpTranscriptProvider(): TranscriptProvider {
  return {
    id: 'mcp',
    label: 'Outil MCP de transcription',
    async fetch(videoId) {
      const tool = await findTranscriptTool();
      if (!tool) return null;
      const res = await callMcpTool(tool.server, tool.name, buildTranscriptArgs(tool, videoId));
      let payload: unknown = res.text;
      if (typeof res.text === 'string' && /^[[{]/.test(res.text.trim())) { try { payload = JSON.parse(res.text); } catch { /* texte */ } }
      const err = payloadError(payload);
      if (res.isError || err) throw new Error(`${tool.server} › ${tool.name} : ${(err ?? res.text ?? 'erreur').toString().slice(0, 200)}`);
      const parsed = normalizeTranscriptPayload(payload) ?? (res.raw != null ? normalizeTranscriptPayload(res.raw) : null);
      if (!parsed || !parsed.segments.length) return null;
      return { videoId, provider: 'mcp', language: parsed.language, segments: parsed.segments, timed: parsed.timed };
    },
  };
}

/** 3) Transcriptions importées à la main (stockées en cache avec provider = manual). */
export function manualProvider(getManual: (videoId: string) => Promise<Transcript | undefined>): TranscriptProvider {
  return {
    id: 'manual',
    label: 'Import manuel',
    fetch: async (videoId) => {
      const t = await getManual(videoId);
      return t && t.provider === 'manual' && t.segments.length ? t : null;
    },
  };
}
