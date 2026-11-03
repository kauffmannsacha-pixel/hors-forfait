// PKCE (RFC 7636) + aléas pour OAuth « application installée » (boucle locale 127.0.0.1).
const UNRESERVED = /^[A-Za-z0-9\-._~]{43,128}$/;

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Chaîne aléatoire base64url (32 octets → 43 caractères). */
export function randomString(byteLength = 32): string {
  const b = new Uint8Array(byteLength);
  crypto.getRandomValues(b);
  return base64UrlEncode(b);
}

export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export const isValidVerifier = (v: string) => UNRESERVED.test(v);

/** code_challenge = BASE64URL(SHA256(ASCII(code_verifier))) — méthode S256. */
export async function pkceChallenge(verifier: string): Promise<string> {
  if (!isValidVerifier(verifier)) throw new Error('code_verifier PKCE invalide (43 à 128 caractères non réservés).');
  return base64UrlEncode(await sha256(verifier));
}

export async function createPkce(): Promise<{ verifier: string; challenge: string; method: 'S256' }> {
  const verifier = randomString(48); // 64 caractères
  return { verifier, challenge: await pkceChallenge(verifier), method: 'S256' };
}

/** Décode la charge utile d'un JWT (id_token reçu directement de Google en HTTPS : pas de vérification de signature nécessaire). */
export function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Jeton d’identité illisible.');
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
}
