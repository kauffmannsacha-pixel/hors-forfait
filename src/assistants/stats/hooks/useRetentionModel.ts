// Modèle de rétention d'une vidéo : points API → série à la seconde, événements, phrases alignées, chapitres.
import { useMemo } from 'react';
import type { YtVideo } from '../../../connectors/api';
import type { Transcript } from '../../../knowledge/api';
import { useAsync, type AsyncState } from './useAsync';
import { getRetention, getTranscriptCached, type RetentionData } from '../data/youtube';
import type { Fetched } from '../data/cache';
import { defaultStep, interpolateRetention, sampleAt, type InterpMethod, type RetentionPoint, type RetentionSample } from '../lib/retention';
import { detectEvents, type RetentionEvent } from '../lib/events';
import { buildSentences, sentenceStats, type Sentence, type SentenceStat } from '../lib/transcript';
import { parseChapters, type ChaptersResult } from '../lib/chapters';
import type { AudienceType } from '../lib/labels';

export interface RetentionModel {
  duration: number;
  step: number;
  points: RetentionPoint[];
  series: RetentionSample[];
  hasRelative: boolean;
  events: RetentionEvent[];
  sentences: Sentence[];
  stats: SentenceStat[];
  chapters: ChaptersResult;
}
export interface RetentionOptions { audience: AudienceType; method: InterpMethod; sensitivity: number }

export function useRetentionModel(video: YtVideo, channelId: string | null, o: RetentionOptions): {
  model: RetentionModel;
  retention: AsyncState<Fetched<RetentionData>>;
  transcript: AsyncState<Fetched<Transcript>>;
} {
  const retention = useAsync(force => getRetention(channelId as string, video, o.audience, force), [video.id, channelId, o.audience], { enabled: !!channelId, ctx: 'analytics' });
  const transcript = useAsync(force => getTranscriptCached(video.id, force), [video.id], { ctx: 'transcript' });
  const D = video.durationSec;
  const chapters = useMemo(() => parseChapters(video.description ?? '', D), [video.description, D]);
  const sentences = useMemo(() => buildSentences(transcript.data?.value.segments ?? []), [transcript.data]);
  const points = retention.data?.value.points;
  const series = useMemo(() => (points?.length ? interpolateRetention(points, D, { method: o.method }) : []), [points, D, o.method]);
  const events = useMemo(() => (series.length ? detectEvents(series, D, { sensitivity: o.sensitivity }) : []), [series, D, o.sensitivity]);
  const stats = useMemo(() => (series.length ? sentenceStats(sentences, t => sampleAt(series, t)) : []), [sentences, series]);
  const model = useMemo<RetentionModel>(() => ({
    duration: D, step: defaultStep(D), points: points ?? [], series, hasRelative: !!retention.data?.value.hasRelative,
    events, sentences, stats, chapters,
  }), [D, points, series, retention.data, events, sentences, stats, chapters]);
  return { model, retention, transcript };
}
