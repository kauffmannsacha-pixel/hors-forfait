# Prisme

**L'espace de travail des créateurs YouTube.** Un clone de Notion pour Windows (pages, blocs, bases de données), avec Claude intégré partout, tes outils connectés (YouTube, Stripe, Discord, Gmail, Google Agenda, Drive, Jarvis) et quatre assistants experts YouTube : script, stats, miniatures, titres.

> Pourquoi « Prisme » : un prisme décompose la lumière en spectre. Prisme décompose une vidéo en ce qui la fait marcher (hook, rétention, miniature, titre), et l'interface est en verre façon Apple Liquid Glass.

---

## 1. Installer

### Option A : télécharger l'installeur
1. Va dans l'onglet **Actions** du dépôt → workflow **Build Windows (.exe)** → dernier run réussi → artefact **Prisme-Setup**.
   (Ou dans **Releases** si une version taguée `v*` a été publiée.)
2. Lance `Prisme-Setup.exe`. L'installation se fait pour ton utilisateur, sans droits administrateur.
3. Windows SmartScreen peut avertir (l'exe n'est pas signé avec un certificat de code payant) : « Informations complémentaires » → « Exécuter quand même ».

### Option B : compiler toi-même (Windows)
Prérequis : [Node 22](https://nodejs.org), [Rust](https://rustup.rs), [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) et WebView2 (déjà présent sur Windows 10/11).

```bash
npm ci
```

```bash
npx tauri build --bundles nsis
```

L'installeur est créé dans `src-tauri/target/release/bundle/nsis/`.

Mode développement (rechargement à chaud) :

```bash
npx tauri dev
```

### Mises à jour automatiques
Prisme vérifie les nouvelles versions publiées dans les Releases GitHub (`latest.json`). Pour que ça marche :
1. Ajoute le secret GitHub `TAURI_SIGNING_PRIVATE_KEY` (contenu de ta clé privée de signature des mises à jour) dans *Settings → Secrets and variables → Actions*.
2. Publie une version en poussant un tag : `git tag v0.1.0 && git push origin v0.1.0`.
3. Le dépôt doit être **public** pour que l'app puisse télécharger `latest.json` sans authentification (sinon héberge les releases ailleurs et change `plugins.updater.endpoints` dans `src-tauri/tauri.conf.json`).

Si tu perds la clé privée, génère-en une nouvelle (`npx tauri signer generate`) et remplace `plugins.updater.pubkey` dans `src-tauri/tauri.conf.json`.

---

## 2. Les clés API à fournir (et où les mettre)

Toutes les clés et jetons sont stockés dans le **Gestionnaire d'identification Windows** (coffre chiffré du système), jamais en clair sur le disque.

| Service | Ce qu'il te faut | Où le mettre dans Prisme |
|---|---|---|
| **Claude (Anthropic)** | Clé API | Réglages → Claude |
| **YouTube, Gmail, Agenda, Drive** | ID client + secret OAuth Google (type « Application de bureau ») + clé API Google (données publiques) | Réglages → Connexions → Google |
| **Stripe** | Clé restreinte en lecture | Réglages → Connexions → Stripe |
| **Discord** | Jeton de bot | Réglages → Connexions → Discord |
| **Autres boîtes mail** | Adresse + mot de passe d'application (IMAP/SMTP) | Réglages → Mail |
| **Génération d'images** (optionnel) | URL + modèle + clé d'une API compatible OpenAI Images | Réglages → Images |
| **Jarvis** | Rien à créer : Prisme génère un jeton | Réglages → Connexions → Jarvis |

### Claude (Anthropic)
1. Crée un compte sur [console.anthropic.com](https://console.anthropic.com), ajoute un moyen de paiement.
2. *API Keys* → *Create Key* → copie la clé `sk-ant-…`.
3. Prisme → Réglages → Claude → colle la clé → « Tester ». Le modèle par défaut est le plus récent Claude Opus (modifiable).

### Google (YouTube Data + YouTube Analytics + Gmail + Agenda + Drive)
1. Va sur [console.cloud.google.com](https://console.cloud.google.com) → crée un projet « Prisme ».
2. *API et services → Bibliothèque* → active : **YouTube Data API v3**, **YouTube Analytics API**, **Gmail API**, **Google Calendar API**, **Google Drive API**.
3. *Écran de consentement OAuth* → type « Externe » → ajoute ton adresse dans **Utilisateurs test** (tant que l'app n'est pas validée par Google, seuls les utilisateurs test peuvent se connecter).
4. *Identifiants → Créer des identifiants → ID client OAuth* → type **Application de bureau** → copie l'**ID client** et le **code secret**.
5. *Identifiants → Créer des identifiants → Clé API* → (recommandé) restreins-la à YouTube Data API v3.
6. Prisme → Réglages → Connexions → Google : colle ID client, secret et clé API, puis « Connecter » (le navigateur s'ouvre pour l'autorisation). Pour plusieurs chaînes YouTube (chaînes de marque comprises), clique « Ajouter une chaîne » et choisis la chaîne dans l'écran Google.

Quota YouTube : 10 000 unités/jour par projet. Prisme met en cache et affiche ta consommation (une recherche coûte 100 unités, un upload ~1 600).

### Stripe
1. [dashboard.stripe.com](https://dashboard.stripe.com) → *Développeurs → Clés API → Créer une clé restreinte*.
2. Droits **Lecture** sur : Charges, Customers, Subscriptions, Invoices, Balance, Payment Intents.
3. Colle la clé `rk_live_…` dans Réglages → Connexions → Stripe.

### Discord
1. [discord.com/developers/applications](https://discord.com/developers/applications) → *New Application* → *Bot* → *Reset Token* → copie le jeton.
2. Active **Message Content Intent** (pour lire les messages des salons suivis).
3. *OAuth2 → URL Generator* : scope `bot`, permissions *View Channels*, *Send Messages*, *Read Message History*, *Embed Links* → ouvre l'URL pour inviter le bot sur ton serveur.
4. Colle le jeton dans Réglages → Connexions → Discord.

### Autres boîtes mail (Outlook, Yahoo, iCloud, OVH, Orange, Free…)
Utilise un **mot de passe d'application** (créé dans les réglages de sécurité de ton fournisseur), pas ton mot de passe principal. Prisme propose les serveurs IMAP/SMTP des fournisseurs courants.

---

## 3. Connecter Jarvis

Prisme ouvre un pont local, accessible seulement depuis ton PC :
- HTTP : `http://127.0.0.1:7777` (port modifiable)
- WebSocket : `ws://127.0.0.1:7777/ws`
- Authentification : en-tête `Authorization: Bearer <jeton>` (jeton affiché dans Réglages → Connexions → Jarvis)

Le protocole complet (routes, messages WebSocket, exemples) est dans [`src/connectors/README.md`](src/connectors/README.md).

---

## 4. Claude et les serveurs MCP

Prisme lit `%APPDATA%\Claude\claude_desktop_config.json` et lance **les mêmes serveurs MCP que Claude Desktop**. Tu peux en ajouter d'autres dans Réglages → Claude. Les outils MCP sont disponibles dans le panneau Claude (`Ctrl+J`) et dans `/claude`.

Claude peut agir sur Prisme (créer des pages, remplir des bases, épingler des fichiers), avec **confirmation avant toute action destructive ou externe** (envoi Discord, mail, publication).

---

## 5. Ajouter un connecteur

Chaque connecteur est un dossier `src/connectors/<id>/` qui implémente l'interface `Connector` (`auth`, `accounts`, `sync`, `blocks`, `tools` pour Claude, `settings`). Guide pas à pas : [`src/connectors/README.md`](src/connectors/README.md).

---

## 6. Raccourcis

| Raccourci | Action |
|---|---|
| `Ctrl+K` | Recherche globale (pages, blocs, fichiers, commandes) |
| `Ctrl+J` | Panneau Claude |
| `Ctrl+N` | Nouvelle page |
| `Ctrl+\` | Afficher / masquer la barre latérale |
| `/` | Menu des blocs |
| `@` | Mentionner une page, une date, un rappel |

---

## 7. Données, sécurité, sauvegardes

- Base locale SQLite (`prisme.db`) avec recherche plein texte FTS5, dans le dossier de l'app (`%APPDATA%\app.prisme.studio`).
- Sauvegarde automatique continue + **copie quotidienne** dans `%APPDATA%\app.prisme.studio\backups` (14 jours conservés).
- Fichiers épinglés copiés dans le vault (`…\vault`), dédupliqués par empreinte SHA-256 ; option « lier » sans copie, avec détection des fichiers déplacés.
- Les données ne partent que vers les API que tu connectes. Aucun mail n'est envoyé automatiquement, aucune vidéo n'est publiée sans confirmation.
- YouTube : uniquement les API officielles (Data v3, Analytics v2). Les transcriptions viennent des sous-titres officiels de **tes** vidéos, d'un outil MCP que tu as configuré, ou d'un import manuel (.srt/.vtt/.txt).

---

## 8. Architecture

```
src/
  db/          SQLite (tauri-plugin-sql), pages, secrets (coffre Windows), fetch sans CORS
  ui/          coque Liquid Glass, registre des modules, palette Ctrl+K, kit de composants
  editor/      éditeur de blocs TipTap/ProseMirror (menu /, poignée, Markdown, mentions…)
  database/    bases de données : 6 vues, propriétés, formules, filtres, tris, groupes
  files/       épinglage de fichiers dans le texte, vault, aperçus
  claude/      panneau Claude, /claude, boucle d'outils, client MCP
  connectors/  YouTube, Google, Stripe, Discord, Jarvis (un dossier par connecteur)
  mail/        Gmail + IMAP/SMTP, tri et brouillons par Claude
  knowledge/   base de connaissances sourcée (embeddings locaux + SQLite)
  assistants/  script, stats, miniatures, titres
  publish/     upload YouTube multi-chaînes, programmation, A/B tests
  studio/      tableau de bord d'accueil
src-tauri/     Rust : coffre, vault, MCP stdio, pont Jarvis, IMAP/SMTP, upload reprenable, sauvegardes
```

Chaque module s'enregistre dans `src/ui/registry.ts` (vues, blocs, commandes `/`, réglages, outils pour Claude), ce qui permet d'ajouter une fonction sans toucher au reste.
