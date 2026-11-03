// Noms d'outils MCP exposés à Claude : « mcp__<serveur>__<outil> » (pur, testable).
// L'API Anthropic n'accepte que [a-zA-Z0-9_-]{1,64} : on assainit, on tronque avec un suffixe
// de hachage stable, et on garde une table de correspondance pour retrouver (serveur, outil).

export const MCP_PREFIX = 'mcp__';
export const MAX_TOOL_NAME = 64;
const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

/** Remplace tout caractère interdit par « _ » (les accents sont d'abord décomposés). */
export function sanitizeNamePart(s: string): string {
  const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return out || '_';
}

/** Hachage FNV-1a 32 bits en base 36 (court, stable). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

/** Nom préfixé « mcp__serveur__outil », assaini et limité à 64 caractères. */
export function prefixToolName(server: string, tool: string): string {
  const full = `${MCP_PREFIX}${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const suffix = '_' + shortHash(`${server}\u0000${tool}`);
  return full.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
}

/** Décomposition naïve (sans table) : « mcp__a__b__c » → { server: 'a', tool: 'b__c' }. */
export function parsePrefixedName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const i = rest.indexOf('__');
  if (i <= 0 || i + 2 >= rest.length) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

export const isMcpToolName = (name: string) => name.startsWith(MCP_PREFIX);
export const isValidToolName = (name: string) => VALID.test(name);

/** Table de correspondance nom exposé ⇄ (serveur, outil), sans collision. */
export class ToolNameRegistry {
  private byName = new Map<string, { server: string; tool: string }>();
  private byKey = new Map<string, string>();

  /** Enregistre un outil et renvoie son nom exposé (unique). */
  add(server: string, tool: string): string {
    const key = `${server}\u0000${tool}`;
    const known = this.byKey.get(key);
    if (known) return known;
    let name = prefixToolName(server, tool);
    if (this.byName.has(name)) {
      // Collision après assainissement (« a.b » et « a_b ») : suffixe de hachage, puis compteur.
      const suffix = '_' + shortHash(key);
      name = name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
      let n = 2;
      while (this.byName.has(name)) {
        const s = `${suffix}${n++}`;
        name = prefixToolName(server, tool).slice(0, MAX_TOOL_NAME - s.length) + s;
      }
    }
    this.byName.set(name, { server, tool });
    this.byKey.set(key, name);
    return name;
  }

  /** (serveur, outil) d'origine pour un nom exposé ; repli sur la décomposition naïve. */
  resolve(name: string): { server: string; tool: string } | null {
    return this.byName.get(name) ?? null;
  }

  nameFor(server: string, tool: string): string | undefined {
    return this.byKey.get(`${server}\u0000${tool}`);
  }

  clear() { this.byName.clear(); this.byKey.clear(); }
  get size() { return this.byName.size; }
}
