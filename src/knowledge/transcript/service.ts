// Branchement de la chaîne de transcription sur le cache du moteur (tables kn_transcripts / IndexedDB).
import type { Transcript } from '../api';
import { engine } from '../engine';
import { createTranscriptChain } from './chain';
import { manualProvider, mcpTranscriptProvider, youtubeCaptionsProvider } from './providers';
import type { ParsedTranscript } from './parse';

/** Ordre imposé : 1) sous-titres officiels de MES vidéos, 2) outil MCP « transcript », 3) import manuel. Cache devant. */
export const transcriptChain = createTranscriptChain(
  [youtubeCaptionsProvider(), mcpTranscriptProvider(), manualProvider(id => engine.getCachedTranscript(id))],
  { get: id => engine.getCachedTranscript(id), set: t => engine.putTranscript(t) },
);

/** Enregistre une transcription importée à la main (prioritaire ensuite grâce au cache). */
export async function saveManualTranscript(videoId: string, parsed: ParsedTranscript): Promise<Transcript> {
  if (!parsed.segments.length) throw new Error('Aucun segment lisible dans ce fichier.');
  const t: Transcript = { videoId, provider: 'manual', language: parsed.language, segments: parsed.segments, timed: parsed.timed };
  await engine.putTranscript(t);
  return t;
}
