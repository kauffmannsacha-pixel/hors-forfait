// Jeu d'emojis (icônes de pages, callouts) avec mots-clés français pour la recherche.
import { fuzzyBest } from './fuzzy';

export interface EmojiEntry { e: string; k: string; cat: string }

const RAW: [string, string][] = [
  ['Smileys', `😀 sourire content heureux|😃 joie heureux|😄 rire joie|😁 grand sourire|😆 mort de rire|😅 gêne sueur|🤣 rire par terre|😂 larmes de rire|🙂 sourire léger|🙃 à l'envers ironie|😉 clin d'œil|😊 timide content|😇 ange innocent|🥰 amoureux cœurs|😍 yeux cœurs adore|🤩 étoiles wow|😘 bisou|😋 miam délicieux|😛 langue|😜 farceur|🤪 fou délire|🤑 argent riche|🤗 câlin|🤭 oups|🤫 chut secret|🤔 réfléchir pensée|🤐 bouche cousue|🤨 sceptique|😐 neutre|😑 blasé|😶 sans voix|😏 narquois|😒 ennuyé|🙄 lever les yeux|😬 grimace|😌 soulagé|😔 pensif triste|😪 fatigué sommeil|😴 dormir|😷 malade masque|🤒 fièvre|🤯 explosion cerveau choqué|🥳 fête anniversaire|😎 cool lunettes|🤓 intello geek|🧐 monocle analyse|😕 confus|😟 inquiet|😮 surpris|😲 stupéfait|🥺 supplier|😢 pleurer triste|😭 sanglot|😱 peur cri|😖 frustré|😤 déterminé colère|😡 colère furieux|🤬 jurer|💀 mort crâne|💩 caca|🤡 clown|👻 fantôme|👽 alien|🤖 robot ia|😺 chat content|❤️ cœur amour rouge|🧡 cœur orange|💛 cœur jaune|💚 cœur vert|💙 cœur bleu|💜 cœur violet|🖤 cœur noir|🤍 cœur blanc|💔 cœur brisé|💯 cent parfait|💥 boum explosion|💫 étourdi|💬 bulle message discussion|💭 pensée bulle|💤 sommeil zzz`],
  ['Personnes', `👋 salut coucou|🤚 main levée|✋ stop main|🖖 vulcain|👌 ok parfait|🤌 italien|✌️ victoire paix|🤞 croiser les doigts chance|🤟 je t'aime|🤘 rock|🤙 appelle-moi|👈 gauche|👉 droite|👆 haut|👇 bas|☝️ index attention|👍 pouce oui bien|👎 pouce non|✊ poing|👊 coup de poing|👏 applaudir bravo|🙌 hourra|🫶 cœur mains|👐 mains ouvertes|🤝 accord poignée de main partenariat|🙏 merci prière svp|✍️ écrire rédiger|💪 force muscle|🧠 cerveau idée intelligence|👀 yeux regarder|👁️ œil voir|👄 bouche|🗣️ parler voix|👤 personne profil|👥 groupe équipe|🧑‍💻 développeur ordinateur|🧑‍🎨 artiste|🧑‍🏫 prof enseignant|🧑‍🔬 scientifique|🧑‍🚀 astronaute|🧑‍🍳 cuisinier|🦸 super-héros|🧙 magicien|🧛 vampire|🧟 zombie|🏃 courir|💃 danser|🧘 méditation yoga|🎅 père noël|👶 bébé|👨‍👩‍👧 famille`],
  ['Nature', `🐶 chien|🐱 chat|🐭 souris|🐹 hamster|🐰 lapin|🦊 renard|🐻 ours|🐼 panda|🐨 koala|🐯 tigre|🦁 lion|🐮 vache|🐷 cochon|🐸 grenouille|🐵 singe|🐔 poule|🐧 pingouin|🐦 oiseau|🦅 aigle|🦉 hibou chouette|🦄 licorne|🐝 abeille|🐛 chenille|🦋 papillon|🐌 escargot lent|🐞 coccinelle|🐢 tortue|🐍 serpent|🦖 dinosaure t-rex|🐙 pieuvre|🦈 requin|🐬 dauphin|🐳 baleine|🐟 poisson|🌸 fleur cerisier|🌹 rose|🌻 tournesol|🌷 tulipe|🌱 pousse croissance|🌿 herbe plante|🍀 trèfle chance|🌵 cactus|🌲 sapin arbre|🌳 arbre|🍁 érable automne|🍂 feuilles automne|🍄 champignon|🌍 terre monde|🌙 lune nuit|⭐ étoile favori|🌟 étoile brillante|✨ étincelles magie nouveau|⚡ éclair rapide énergie|🔥 feu tendance populaire|🌈 arc-en-ciel|☀️ soleil|🌤️ beau temps|☁️ nuage|🌧️ pluie|⛈️ orage|❄️ neige flocon hiver|☃️ bonhomme de neige|🌊 vague océan|💧 goutte eau`],
  ['Nourriture', `🍏 pomme verte|🍎 pomme rouge|🍐 poire|🍊 orange|🍋 citron|🍌 banane|🍉 pastèque|🍇 raisin|🍓 fraise|🍒 cerise|🍑 pêche|🥭 mangue|🍍 ananas|🥥 coco|🥝 kiwi|🍅 tomate|🥑 avocat|🥕 carotte|🌽 maïs|🥦 brocoli|🥐 croissant|🥖 baguette pain|🧀 fromage|🥚 œuf|🍳 cuisine poêle|🥞 crêpes|🥓 bacon|🍔 burger|🍟 frites|🍕 pizza|🌭 hot-dog|🌮 taco|🍣 sushi|🍜 ramen|🍝 pâtes|🍰 gâteau|🎂 anniversaire gâteau|🧁 cupcake|🍩 donut|🍪 cookie|🍫 chocolat|🍬 bonbon|🍿 popcorn cinéma|☕ café|🍵 thé|🧃 jus|🥤 soda|🍺 bière|🍷 vin|🥂 trinquer champagne|🍾 champagne célébration`],
  ['Activités', `⚽ football|🏀 basket|🏈 football américain|⚾ baseball|🎾 tennis|🏐 volley|🏓 ping-pong|🏸 badminton|🥊 boxe|🥋 karaté|⛳ golf|🎣 pêche|🏂 snowboard|⛷️ ski|🏋️ musculation sport|🚴 vélo|🏊 natation|🏆 trophée victoire|🥇 médaille or premier|🥈 médaille argent|🥉 médaille bronze|🏅 médaille|🎖️ décoration|🎯 cible objectif|🎮 jeu vidéo manette gaming|🕹️ joystick arcade|🎲 dé jeu|🧩 puzzle|♟️ échecs stratégie|🎨 art peinture palette|🎭 théâtre|🎬 clap cinéma tournage vidéo|🎤 micro chanter podcast|🎧 casque musique audio|🎼 partition|🎹 piano|🥁 batterie|🎸 guitare|🎺 trompette|🎻 violon|🎪 cirque|🎟️ ticket|🎫 billet|🎉 fête confettis|🎊 célébration|🎈 ballon|🎁 cadeau|🎀 ruban`],
  ['Voyages', `🚗 voiture|🚕 taxi|🚌 bus|🏎️ course|🚓 police|🚑 ambulance|🚒 pompiers|🚚 camion livraison|🚲 vélo|🛴 trottinette|🏍️ moto|✈️ avion voyage|🚀 fusée lancement|🛸 ovni|🚁 hélicoptère|⛵ voilier|🚢 bateau|🚂 train|🚇 métro|⚓ ancre|🗺️ carte|🧭 boussole direction|🏔️ montagne|🌋 volcan|🏕️ camping|🏖️ plage vacances|🏝️ île|🏠 maison accueil|🏡 maison jardin|🏢 bureau immeuble|🏬 magasin|🏥 hôpital|🏦 banque|🏫 école|🏰 château|🗼 tour|🗽 liberté|⛪ église|🕌 mosquée|🌆 ville|🌃 nuit ville|🌉 pont|🎡 grande roue|🎢 montagnes russes|🗓️ calendrier|⏰ réveil alarme rappel|⏱️ chronomètre|⌛ sablier temps|🕐 horloge heure`],
  ['Objets', `📱 téléphone mobile|💻 ordinateur portable|🖥️ écran ordinateur|⌨️ clavier|🖱️ souris|🖨️ imprimante|💾 disquette sauvegarde|💿 cd|📷 appareil photo|📸 photo flash|📹 caméra vidéo|🎥 caméra cinéma|📺 télévision|📻 radio|🎙️ micro studio|🔋 batterie|🔌 prise|💡 ampoule idée astuce|🔦 lampe|🕯️ bougie|📚 livres bibliothèque|📖 livre ouvert lecture|📓 cahier|📒 carnet|📕 livre rouge|📗 livre vert|📘 livre bleu|📙 livre orange|📝 note mémo écrire|✏️ crayon|🖊️ stylo|🖋️ plume|🖌️ pinceau|🖍️ crayon de couleur|📄 page document|📃 page enroulée|📑 onglets|📊 graphique barres statistiques|📈 hausse croissance tendance|📉 baisse|🗂️ classeur|📁 dossier|📂 dossier ouvert|🗃️ archive|🗄️ armoire|🗑️ corbeille poubelle|📋 presse-papiers checklist|📌 punaise épingle|📍 épingle lieu|📎 trombone pièce jointe|🖇️ trombones|📏 règle|📐 équerre|✂️ ciseaux|🔒 cadenas sécurité|🔓 ouvert|🔑 clé|🗝️ vieille clé|🔨 marteau|🛠️ outils réglages|⚙️ engrenage paramètres|🧰 boîte à outils|🧲 aimant|🧪 tube essai expérience|🔬 microscope|🔭 télescope|💊 médicament|🩺 stéthoscope|💰 argent sac|💵 billet dollar|💶 billet euro|💳 carte bancaire paiement|🧾 reçu facture|💎 diamant|⚖️ balance justice|📦 colis paquet|📫 boîte aux lettres|📧 email mail|✉️ enveloppe lettre|📨 courrier entrant|📤 envoi|📥 réception|📮 poste|🏷️ étiquette|🔖 marque-page|🛒 caddie achats|🎒 sac à dos|👓 lunettes|🕶️ lunettes de soleil|👑 couronne roi|💼 mallette travail|🧳 valise|☂️ parapluie|🔔 cloche notification|🔕 silencieux|📣 mégaphone annonce|📢 haut-parleur|🔍 loupe recherche|🔎 loupe droite|🧮 boulier calcul|🪄 baguette magique|🧸 ours en peluche|🖼️ tableau image|🪞 miroir`],
  ['Symboles', `✅ validé fait coche|☑️ case cochée|✔️ coche|❌ croix erreur non|❎ croix|➕ plus ajouter|➖ moins|➗ diviser|✖️ multiplier|❓ question|❗ exclamation important|‼️ double exclamation|⚠️ attention avertissement|🚫 interdit|⛔ sens interdit|🔴 rond rouge|🟠 rond orange|🟡 rond jaune|🟢 rond vert|🔵 rond bleu|🟣 rond violet|⚫ rond noir|⚪ rond blanc|🟥 carré rouge|🟧 carré orange|🟨 carré jaune|🟩 carré vert|🟦 carré bleu|🟪 carré violet|🔺 triangle|🔻 triangle bas|💠 losange|🔷 losange bleu|🔶 losange orange|♻️ recyclage|🔁 répéter boucle|🔄 actualiser|⏩ avance rapide|⏪ retour|▶️ lecture play|⏸️ pause|⏹️ stop|⏺️ enregistrer|🔀 aléatoire|🔜 bientôt|🔝 top|🆕 nouveau new|🆗 ok|🆒 cool|🆓 gratuit|🆙 up|ℹ️ information|🅰️ a|🔤 alphabet|🔢 nombres|#️⃣ dièse|🔣 symboles|♾️ infini|💲 dollar|💱 change|™️ marque|©️ copyright|®️ déposé|〰️ vague|➰ boucle|✳️ astérisque|❇️ étincelle|🔆 luminosité|🔅 faible|📶 réseau|🎵 note musique|🎶 notes|☮️ paix|☯️ yin yang|♈ bélier|🏁 drapeau arrivée|🚩 drapeau rouge alerte|🏳️ drapeau blanc|🏴 drapeau noir|🇫🇷 france drapeau|🇧🇪 belgique|🇨🇭 suisse|🇨🇦 canada|🇬🇧 royaume-uni|🇺🇸 états-unis|🇪🇸 espagne|🇩🇪 allemagne|🇮🇹 italie|🇯🇵 japon`],
];

export const EMOJI_CATEGORIES: { id: string; label: string; icon: string }[] = [
  { id: 'Smileys', label: 'Smileys et émotions', icon: '😀' },
  { id: 'Personnes', label: 'Personnes', icon: '👋' },
  { id: 'Nature', label: 'Animaux et nature', icon: '🌿' },
  { id: 'Nourriture', label: 'Nourriture', icon: '🍕' },
  { id: 'Activités', label: 'Activités', icon: '🎮' },
  { id: 'Voyages', label: 'Voyages et lieux', icon: '✈️' },
  { id: 'Objets', label: 'Objets', icon: '💡' },
  { id: 'Symboles', label: 'Symboles', icon: '✅' },
];

export const EMOJIS: EmojiEntry[] = RAW.flatMap(([cat, list]) => list.split('|').map(item => {
  const sp = item.indexOf(' ');
  return { e: item.slice(0, sp), k: item.slice(sp + 1), cat };
}));

/** Emojis correspondant à une recherche (mots-clés français, sans accents). */
export function searchEmojis(query: string, limit = 120): EmojiEntry[] {
  if (!query.trim()) return EMOJIS.slice(0, limit);
  return EMOJIS
    .map(x => ({ x, s: fuzzyBest(query, [[x.k, 1]]) }))
    .filter((r): r is { x: EmojiEntry; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(r => r.x);
}

const PAGE_ICONS = '📄 📝 💡 🚀 🎬 🎯 📚 🧠 ✨ 🔥 📌 🗂️ 📊 🎨 🎮 🧩 🌱 ⭐ 🗓️ 💼'.split(' ');
export const randomPageIcon = () => PAGE_ICONS[Math.floor(Math.random() * PAGE_ICONS.length)];

const RECENT_KEY = 'prisme:ui:emoji-recent';
export function recentEmojis(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; }
}
export function pushRecentEmoji(e: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmojis().filter(x => x !== e)].slice(0, 24))); } catch { /* stockage indisponible */ }
}
