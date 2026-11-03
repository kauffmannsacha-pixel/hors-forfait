# Règles de travail multi-agents — Prisme

Prisme = l'app décrite dans `docs/SPEC.md` (nom final « Prisme », ex-« Forge »). Tauri 2 + React 18 + TS strict + Vite. Interface 100 % en français.

## Contrats partagés (à LIRE avant de coder, à NE PAS modifier sauf si tu en es propriétaire — ajout seulement)
- `src/db/types.ts` types (Page, VaultFile, PropertyDef, DbView…) · `src/db/store.ts` (repo SQLite/localStorage, `uid`, `isTauri`) · `src/db/pages.ts` (createPage/updatePage/usePages…) · `src/db/secrets.ts` (coffre Windows) · `src/db/http.ts` (`httpFetch` sans CORS, `httpError`)
- `src/ui/registry.ts` : registerView / registerPageRenderer / registerEditorExtension / registerSlashItem / registerCommand / registerSettingsPanel / registerClaudeTool / registerSidePanel
- `src/ui/appState.ts` : navigation (`openPage`, `openView`), `openSidePanel`, `toast`, `confirmAction` · `src/ui/kit.tsx` : Button, Card, Field, Input, TextArea, Select, Tabs, Sheet, Empty, Score, Chip, SourceCite · `src/ui/theme.css` (tokens `--accent`, `--glass`, `.glass`, …)
- `src/claude/api.ts` : `askClaude`, `askClaudeJSON`, images (Vision), streaming `onText`
- `src/knowledge/api.ts` : `searchPrinciples`, `formatCitation`, `principlesToPrompt`
- `src/database/api.ts` : `createDatabase`, `ensureDatabase`, `addRow`, `updateRow`, `rowsOf`, `getSchema`
- `src/files/api.ts` : `files.importPath/importBytes/open/usages/url`, `FILE_PIN_NODE`
- `src/connectors/api.ts` : `youtube`, `google`, `stripe`, `discord`, `registerConnector`
- `src/editor/BlockEditor.tsx` : `<BlockEditor content onChange mode />`

Chaque module s'enregistre via son `src/<module>/index.ts` (déjà importé par `src/App.tsx`).

## Règles
1. Ne modifie QUE les fichiers de ton périmètre. Interdit : `package.json`, lockfile, `Cargo.toml`, `src-tauri/src/lib.rs`, `tauri.conf.json`, `capabilities/`, `src/App.tsx`, contrats des autres. Besoin d'un changement ailleurs ? Écris-le dans `notes/<ton-module>.md`.
2. Pas de `npm install` / `cargo add` : dépendances déjà installées (voir package.json : TipTap v3 + extensions, @dnd-kit, @tanstack/react-virtual, recharts, @visx/*, motion, date-fns, jszip, turndown, marked, dompurify, katex, @huggingface/transformers, @modelcontextprotocol/sdk, @anthropic-ai/sdk, plugins @tauri-apps/* http/shell/fs/dialog/opener/notification/updater/process/sql, @fabianlars/tauri-plugin-oauth). Crates Rust dispo : tokio, reqwest, sha2, hex, futures-util, async-imap, async-native-tls, lettre, mail-parser, chrono, base64, uuid, dirs, notify, axum (ws), mime_guess, keyring. Manque quelque chose ? → notes.
3. Pas de `git commit/push` : l'orchestrateur intègre.
4. Vérif TS : `npx tsc --noEmit 2>&1 | grep 'src/<ton-dossier>'` → zéro erreur dans ton périmètre. Tests vitest dans `src/<dossier>/__tests__/` pour la logique pure (`npx vitest run src/<dossier>`).
5. Rust : uniquement dans ton fichier `src-tauri/src/<mod>.rs` (déjà déclaré dans lib.rs). Vérif : `cd src-tauri && cargo check 2>&1 | grep -B2 -A8 '<mod>.rs'`. Les commandes seront enregistrées par l'orchestrateur : liste-les dans ton rapport final.
6. Code complet, pas de placeholder/TODO/maquette. Vraies API officielles (endpoints réels). Messages d'erreur en français.
7. Sécurité : secrets via `secrets` (jamais en clair), `confirmAction` avant toute action destructive ou externe (envoi Discord, publication, mail…). Jamais d'envoi automatique de mail. Pas de scraping contraire aux CGU YouTube.
8. Design Apple « Liquid Glass » : matériaux `.glass` (blur), hiérarchie par poids/taille, tracking négatif sur les gros titres, retour visuel au pointer-down, animations à ressort interruptibles (`motion` : `type:'spring', bounce:0` par défaut, rebond seulement après un geste avec élan), drag 1:1 avec offset de saisie, rubber-banding aux bords, respect de `prefers-reduced-motion`/`reduced-transparency`. Tokens CSS de `theme.css` (clair/sombre). Le CSS de ton module va dans `src/<dossier>/*.css` importé par tes composants.
9. Rapport final (court) : fichiers créés, commandes Rust à enregistrer + permissions Tauri nécessaires, dépendances manquantes, ce qui n'a pas pu être testé.
