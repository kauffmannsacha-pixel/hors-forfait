// Messages d'erreur en français, adaptés au contexte (Data API, Analytics, revenus, Reporting, transcription, Claude).
export type ErrorContext = 'data' | 'analytics' | 'monetary' | 'reporting' | 'transcript' | 'claude' | 'export';

const msgOf = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })()) ?? '';
const has = (m: string, ...needles: (string | RegExp)[]) => needles.some(n => (typeof n === 'string' ? m.toLowerCase().includes(n.toLowerCase()) : n.test(m)));

export const isNotConnected = (e: unknown) => has(msgOf(e), 'n\'est pas connecté', 'n’est pas connecté', 'not connected');
export const isQuota = (e: unknown) => has(msgOf(e), 'quotaExceeded', 'dailyLimitExceeded', 'quota épuisé');
export const isForbidden = (e: unknown) => !isQuota(e) && has(msgOf(e), /\b403\b/, 'forbidden', 'insufficientPermissions', 'accès interdit', 'PERMISSION_DENIED', 'monetizationDisabled');
export const isBadRequest = (e: unknown) => has(msgOf(e), /\b400\b/, 'badRequest', 'INVALID_ARGUMENT', 'invalidArgument', 'Unknown identifier', 'not supported');
export const isAuth = (e: unknown) => has(msgOf(e), /\b401\b/, 'authError', 'invalid_grant', 'authentification refusée', 'Invalid Credentials', 'UNAUTHENTICATED');

export function explainError(e: unknown, ctx: ErrorContext = 'data'): string {
  const m = msgOf(e);
  if (isNotConnected(e)) return 'YouTube n’est pas connecté — ouvre Réglages → Connexions pour lier ta chaîne (ou ajouter une clé API).';
  if (isQuota(e)) return 'Quota YouTube épuisé pour aujourd’hui (remise à zéro à minuit, heure du Pacifique). Les données déjà en cache restent consultables.';
  if (isAuth(e)) return 'Session YouTube expirée ou révoquée — reconnecte la chaîne dans Réglages → Connexions.';
  if (isForbidden(e)) {
    if (ctx === 'monetary') return 'Revenus indisponibles : chaîne hors Programme Partenaire YouTube, ou autorisation « yt-analytics-monetary.readonly » non accordée (reconnecte la chaîne).';
    if (ctx === 'analytics') return 'Accès YouTube Analytics refusé : la vidéo n’appartient pas à la chaîne connectée, ou l’autorisation « yt-analytics.readonly » manque (reconnecte la chaîne).';
    if (ctx === 'reporting') return 'YouTube Reporting a refusé l’accès : l’autorisation « yt-analytics.readonly » est nécessaire (reconnecte la chaîne).';
    return 'Accès refusé par YouTube (vidéo privée, autorisation manquante ou quota dépassé).';
  }
  if (has(m, /\b429\b/, 'rateLimitExceeded', 'trop de requêtes')) return 'YouTube limite le débit des requêtes — réessaie dans une minute.';
  if (has(m, /\b404\b/, 'introuvable', 'videoNotFound', 'notFound')) {
    return ctx === 'transcript' ? 'Aucune transcription disponible pour cette vidéo.' : 'Ressource introuvable : vidéo supprimée, privée ou URL invalide.';
  }
  if (isBadRequest(e)) {
    return (ctx === 'analytics' || ctx === 'monetary' ? 'Requête Analytics refusée par YouTube (métrique indisponible pour cette vidéo ou cette période).' : 'Requête refusée par YouTube.') + (m ? ' Détail : ' + m.slice(0, 160) : '');
  }
  if (has(m, 'Failed to fetch', 'NetworkError', 'ENOTFOUND', 'ECONN', 'timed out', 'timeout', 'error sending request')) return 'Connexion impossible — vérifie ta connexion Internet.';
  if (has(m, 'Requête annulée', 'AbortError', 'aborted')) return 'Opération annulée.';
  if (ctx === 'transcript') return m.startsWith('Aucune') ? m : 'Transcription indisponible : ' + m;
  return m || 'Erreur inconnue.';
}
