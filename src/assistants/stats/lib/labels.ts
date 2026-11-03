// Libellés français des valeurs de dimensions YouTube Analytics v2 (liste officielle des dimensions).

/** insightTrafficSourceType */
export const TRAFFIC_LABELS: Record<string, string> = {
  ADVERTISING: 'Publicité',
  ANNOTATION: 'Annotations',
  CAMPAIGN_CARD: 'Cartes de campagne',
  END_SCREEN: 'Écrans de fin',
  EXT_URL: 'Sites externes (dont Google)',
  HASHTAGS: 'Pages de hashtags',
  LIVE_REDIRECT: 'Redirections de live',
  NO_LINK_EMBEDDED: 'Lecteurs intégrés',
  NO_LINK_OTHER: 'Accès direct ou inconnu',
  NOTIFICATION: 'Notifications',
  PLAYLIST: 'Playlists',
  PRODUCT_PAGE: 'Pages produit',
  PROMOTED: 'Promotion YouTube',
  RELATED_VIDEO: 'Vidéos suggérées',
  SHORTS: 'Flux Shorts',
  SOUND_PAGE: 'Pages de sons (Shorts)',
  SUBSCRIBER: 'Accueil et abonnements',
  VIDEO_REMIXES: 'Remix',
  WATCH_WITH: 'Regarder avec (commentaires)',
  YT_CHANNEL: 'Pages de chaîne',
  YT_OTHER_PAGE: 'Autres pages YouTube',
  YT_PLAYLIST_PAGE: 'Pages de playlist',
  YT_SEARCH: 'Recherche YouTube',
};
/** deviceType */
export const DEVICE_LABELS: Record<string, string> = {
  DESKTOP: 'Ordinateur',
  MOBILE: 'Mobile',
  TABLET: 'Tablette',
  TV: 'Télévision',
  GAME_CONSOLE: 'Console de jeu',
  AUTOMOTIVE: 'Voiture',
  WEARABLE: 'Objet connecté',
  UNKNOWN_PLATFORM: 'Inconnu',
};
/** Filtre audienceType du rapport de rétention. */
export const AUDIENCE_LABELS = {
  ALL: 'Toutes les audiences',
  ORGANIC: 'Organique',
  AD_INSTREAM: 'Annonces InStream',
  AD_INDISPLAY: 'Annonces In-Feed',
} as const;
export type AudienceType = keyof typeof AUDIENCE_LABELS;

export const trafficLabel = (k: string) => TRAFFIC_LABELS[k] ?? k.replace(/_/g, ' ').toLowerCase();
export const deviceLabel = (k: string) => DEVICE_LABELS[k] ?? k;
