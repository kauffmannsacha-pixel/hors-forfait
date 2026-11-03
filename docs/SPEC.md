# PROMPT — « Prisme » : Notion révolutionnaire pour créateur YouTube (.exe Windows)

> À coller tel quel dans Claude Code (ou Claude Desktop avec accès au dossier du projet).

---

## Rôle

Tu es un ingénieur senior full-stack spécialisé en applications desktop (Electron/Tauri), en éditeurs de blocs type Notion, en intégrations API et en analytics YouTube. Tu construis l'application **de A à Z**, complète et fonctionnelle, en une seule passe propre : pas de maquette, pas de placeholder, pas de « TODO à implémenter ». Si un choix technique n'est pas précisé, tu prends la meilleure option et tu la notes dans le README.

## Objectif

Construire **Prisme**, un logiciel **.exe Windows** qui est une **copie conforme de Notion** (mêmes fonctionnalités, même ergonomie, même fluidité), augmenté de :
1. Une **connexion native à Claude** (API Anthropic + serveurs MCP utilisés par Claude Desktop).
2. Des **connexions à tous mes outils** : Stripe, Jarvis (mon assistant), YouTube, Discord, Google Calendar/Drive, Gmail, et un système de plugins pour en ajouter d'autres.
3. Une **suite de 4 assistants IA experts YouTube** (script, analyse de stats, miniatures, titres).

---

## Stack imposée

- **Tauri 2** (Rust) + **React 18 + TypeScript + Vite** → .exe léger. (Fallback Electron si une lib l'exige — justifie-le.)
- Éditeur : **TipTap / ProseMirror** (blocs façon Notion).
- Base locale : **SQLite** (via `tauri-plugin-sql`) + recherche plein texte **FTS5**.
- Graphiques : **Recharts** + **visx** pour les graphiques avancés (courbes de rétention, heatmaps, annotations).
- Secrets (clés API, tokens OAuth) : **coffre Windows Credential Manager** via `keyring`, jamais en clair.
- Installeur : **NSIS** via `tauri build` → `Prisme-Setup.exe` + mise à jour automatique.
- Design : **Apple Liquid Glass** (verre dépoli, flou, profondeur, animations à ressort), thème clair/sombre, polices Inter / SF-like.

---

## Module 1 — Le clone de Notion (le socle, doit être parfait)

- **Pages imbriquées** infinies, sidebar arborescente (glisser-déposer, favoris, corbeille, restauration).
- **Éditeur de blocs** : texte, titres H1-H3, listes, to-do, toggle, citation, callout, code (coloration), séparateur, tableau simple, colonnes, équations, embed, image, vidéo, audio, fichier.
- **Menu `/`** pour insérer un bloc, **poignée ⋮⋮** pour déplacer, **Markdown live** (`#`, `-`, `[]`, `>`…).
- **Bases de données** : vues Tableau, Board (kanban), Calendrier, Galerie, Liste, Timeline ; propriétés (texte, nombre, select, multi-select, date, personne, case, URL, fichier, relation, rollup, formule) ; filtres, tris, groupes.
- **Templates** de pages et de bases.
- **Recherche globale** `Ctrl+K` (pages, blocs, fichiers, commandes).
- **Historique de versions** par page, undo/redo illimité.
- **Export** Markdown / PDF / HTML, **import** depuis Notion (zip export).
- **Mentions** `@page`, `@date`, `@rappel`.

### ⭐ Épinglage de fichiers dans le texte
- Glisser un fichier (PDF, image, vidéo, .lua, .psd, n'importe quoi) **directement dans une phrase** → il devient une **puce inline** dans le texte (icône + nom), comme une mention.
- Survol → **aperçu** (miniature image/vidéo, 1re page PDF, extrait de code).
- Clic → ouvre dans un panneau latéral ou dans l'app Windows par défaut.
- Les fichiers sont copiés dans une bibliothèque locale gérée (`/vault`), dédupliqués par hash, avec un onglet « Fichiers » qui liste toutes les pages où chaque fichier est épinglé.
- Option : **lier** au lieu de copier (chemin d'origine, avec détection si le fichier bouge).

---

## Module 2 — Claude partout

- **Panneau Claude** (`Ctrl+J`) à droite, qui voit la page ouverte, les fichiers épinglés et la sélection.
- **Commande `/claude`** dans l'éditeur : rédiger, résumer, réécrire, traduire, transformer en tableau, générer une base de données.
- **Client MCP intégré** : lit le fichier de config de Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`) pour réutiliser **les mêmes serveurs MCP**, + possibilité d'en ajouter dans les réglages.
- Modèle par défaut : le plus récent Claude Opus disponible, réglable. Streaming des réponses, historique des conversations rattaché à chaque page.
- Claude peut **agir** sur l'app (créer des pages, remplir des bases, épingler des fichiers) via des outils internes, avec confirmation avant toute action destructive.

---

## Module 3 — Connecteurs

Page **Réglages → Connexions** avec bouton « Connecter » (OAuth ou clé API) pour chaque service :

| Service | Ce que Prisme en fait |
|---|---|
| **Stripe** | Bloc « Revenus » (MRR, ventes du jour, abonnés, graphique), base synchronisée des paiements |
| **Jarvis** | Pont local (HTTP/WebSocket sur localhost) : Jarvis peut lire/écrire des pages, Prisme peut lui envoyer des commandes vocales/textes |
| **YouTube Data API v3 + YouTube Analytics API** | Données de chaîne et de vidéos (voir modules 4-7) |
| **Discord** | Envoyer une page/annonce dans un salon, recevoir des messages dans une base |
| **Google Calendar / Gmail / Drive** | Vue calendrier unifiée, mail → page, fichiers Drive épinglables |

- Architecture **plugins** : chaque connecteur = un module dans `/connectors` avec une interface commune (`auth`, `sync`, `blocks`, `tools pour Claude`). Documente comment en ajouter un.
- Synchro en arrière-plan, cache local, mode hors-ligne.

---

## Base de connaissances YouTube (partagée par les 4 assistants)

Avant tout, construire un **moteur de connaissances** :
- Un module qui **recherche et ingère les tutos/conseils des gros YouTubeurs** sur chaque sujet (scripting, rétention, miniatures, titres) : MrBeast (dont son document interne de production qui a fuité publiquement), Paddy Galloway, Colin & Samir, Ali Abdaal, Veritasium (« clickbait honnête »), Film Booth, Think Media, Creator Booth, etc.
- Ingestion via **YouTube Data API** (recherche) + **transcriptions** (sous-titres auto via `youtube-transcript` ou équivalent).
- Chaque transcription est **découpée, résumée et indexée** (embeddings locaux + SQLite) → bibliothèque de « principes » sourcés (vidéo + timestamp).
- Bouton « Mettre à jour les connaissances » + mise à jour automatique hebdomadaire.
- **Chaque conseil donné par un assistant cite sa source** (« Principe : hook en < 5 s — source : Paddy Galloway, 03:42 »).

---

## Module 4 — Assistant Script YouTube

- Nouvelle page « Script » avec structure guidée : **Hook (0-30 s) → Promesse → Intrigue / boucles ouvertes → Corps (montée de tension) → Re-hooks réguliers → Payoff → CTA**.
- Génère un script complet à partir d'une idée, d'un style (Roblox, gaming, vlog, éducatif) et d'une durée cible.
- **Score en direct** pendant que j'écris : force du hook, nombre de boucles ouvertes, rythme (mots/minute), moments « morts », clarté de la promesse.
- Suggestions inline (comme un correcteur) : « Ce passage de 40 s n'a aucun re-hook — ajoute une question ou un teaser. »
- Mode « Analyser un script de MrBeast » : coller l'URL d'une vidéo → transcription découpée par blocs avec annotation de chaque technique utilisée.

## Module 5 — Analyseur de stats vidéo ultra poussé

- Sélection d'une de mes vidéos (OAuth YouTube Analytics) ou de n'importe quelle vidéo publique (données publiques uniquement).
- **Graphiques ultra précis** :
  - Courbe de **rétention d'audience** seconde par seconde, superposée à la **transcription** et aux **chapitres** → on voit exactement quelle phrase fait décrocher.
  - Vues par heure les 48 premières heures, puis par jour (comparaison avec mes 10 dernières vidéos).
  - CTR des impressions, sources de trafic, durée moyenne, abonnés gagnés/perdus, revenus (si dispo), géographie, appareils.
  - Pics et chutes **annotés automatiquement** sur le graphique.
  - Zoom, survol précis, export PNG/CSV.
- **Rapport IA** : retours notés sur 10 pour **Hook, Intrigue, Rythme, Payoff, Miniature, Titre**, avec explication, moment précis (timestamp) et conseil sourcé de la base de connaissances.
- Comparaison avec une vidéo de référence d'un gros YouTubeur du même thème.

## Module 6 — Miniatureur ultra puissant

- **Analyse des miniatures des giga gros YouTubeurs** : récupère les miniatures des vidéos les plus vues d'une niche/chaîne, et les analyse avec Claude Vision : visage/émotion, nombre d'éléments, contraste, couleurs dominantes, texte (nombre de mots), point focal, lisibilité en petit format.
- **Mur d'inspiration** filtrable par niche, couleur, émotion, performance (vues/abonnés).
- **Analyse de ma miniature** : je dépose mon image → score + retours précis + aperçu simulé dans un faux fil YouTube (desktop, mobile, mode sombre) à côté des concurrents.
- **Générateur** : brief + concepts (3-5 propositions de composition détaillées), + génération d'image si une API d'image est connectée (réglable), + éditeur simple (texte, contour, glow, recadrage 1280×720).
- Test A/B : garder plusieurs versions, et suivre laquelle performe (via CTR).

## Module 7 — Générateur de titres

- Analyse des titres des vidéos à succès d'une niche : longueur, mots puissants, curiosité, chiffres, émotions, structure → patterns extraits.
- Génère **20 titres** classés par score prédit, avec la raison de chaque score et le pattern utilisé.
- Vérifie la **cohérence titre ↔ miniature** (ne pas répéter, se compléter).
- Contrôle longueur (troncature mobile ~50 caractères visibles), mode FR/EN.

## Module 8 — Boîte mail intégrée

- Client mail complet dans Prisme : **Gmail (OAuth) + IMAP/SMTP** pour les autres adresses, plusieurs comptes.
- Boîte de réception unifiée, fils de discussion, libellés/dossiers, recherche, pièces jointes (épinglables dans une page en un glisser).
- **Répondre, transférer, rédiger** directement dans Prisme, avec l'éditeur de blocs (mise en forme, signature).
- **Claude pour les mails** : résumé d'un fil, brouillon de réponse dans mon ton, tri automatique (sponsors, collabs, fans, factures), détection des mails urgents.
- Mail → page / tâche en un clic (ex. proposition de sponsor → carte dans la base « Partenariats »).
- **Jamais d'envoi automatique** : Claude prépare le brouillon, j'envoie moi-même.

## Module 9 — Publication YouTube avancée (multi-chaînes)

- Connexion de **plusieurs chaînes** (OAuth par chaîne), sélecteur de chaîne au moment de publier.
- **Upload** via YouTube Data API v3 (envoi en plusieurs morceaux qui reprend s'il est coupé, barre de progression, file d'attente de plusieurs vidéos).
- **Tous les paramètres** : titre, description (templates + liens auto), tags, catégorie, langue, sous-titres (.srt), chapitres (auto depuis le script), miniature, playlist(s), visibilité (privée / non répertoriée / publique), **programmation** date + heure, « conçue pour les enfants », contenu altéré/synthétique, licence, embed, notifications abonnés, écran de fin et fiches (si l'API le permet, sinon checklist).
- **Heure de publication optimale** suggérée selon quand mon audience est en ligne (Analytics).
- **A/B testing** :
  - Plusieurs miniatures et titres par vidéo.
  - Si le « Tester et comparer » natif de YouTube n'est pas accessible par l'API, Prisme fait le test lui-même : il fait tourner les variantes à intervalles réglables (ex. toutes les 24 h) et compare **CTR, vues et durée moyenne** pour chaque période.
  - Déclare un gagnant (avec un indice de confiance) et l'applique automatiquement si je l'ai autorisé.
  - Historique de tous les tests → les leçons sont ajoutées à la base de connaissances.
- **Checklist avant publication** générée par les assistants (score du titre, de la miniature, du hook) + aperçu de la vidéo dans un faux fil YouTube.
- Lien avec le kanban : quand la vidéo est publiée, la carte passe à « Publié » et les stats commencent à remonter.
- Confirmation obligatoire avant toute mise en ligne publique.

---

## Tableau de bord « Studio »

Page d'accueil spéciale : vidéos récentes + perfs, revenus Stripe, idées en cours (base kanban Idée → Script → Tournage → Montage → Publié), calendrier de publication, raccourcis vers les 4 assistants.

---

## Exigences techniques

- **Performance** : démarrage < 2 s, frappe sans latence même sur une page de 10 000 blocs (virtualisation).
- **Sécurité** : tokens dans le coffre Windows, aucune donnée envoyée ailleurs qu'aux API choisies, confirmation avant toute action externe (envoi Discord, paiement, publication).
- **Respect des CGU** : utiliser les API officielles (YouTube Data/Analytics), pas de scraping qui viole les conditions ; gérer les quotas YouTube (cache, file d'attente).
- **Robustesse** : sauvegarde automatique continue, backup quotidien de la base, gestion d'erreurs claire avec messages en français.
- **Code** : TypeScript strict, architecture modulaire (`/editor`, `/db`, `/connectors`, `/assistants`, `/knowledge`, `/ui`), tests sur l'éditeur et la base.
- **Langue de l'interface** : français.

## Livrables

1. Code source complet et organisé.
2. `Prisme-Setup.exe` compilé et testé.
3. `README.md` : installation, obtention de chaque clé API (Anthropic, YouTube, Stripe, Discord, Google), connexion de Jarvis, ajout d'un connecteur.
4. Base de connaissances pré-remplie au premier lancement (après connexion YouTube).

## Méthode de travail

1. Commence par me lister l'architecture et le plan en 10 lignes max, puis **enchaîne directement** sans attendre.
2. Construis dans cet ordre : socle Notion → épinglage de fichiers → Claude/MCP → connecteurs → boîte mail → base de connaissances → 4 assistants → publication YouTube → Studio → build .exe.
3. Teste chaque module avant de passer au suivant.
4. À la fin, donne-moi la liste exacte des clés API à fournir et où les mettre.
