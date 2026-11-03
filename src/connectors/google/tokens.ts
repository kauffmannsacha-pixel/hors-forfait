// Jetons OAuth Google (comptes Google et chaînes YouTube) : coffre `secrets` uniquement, rafraîchissement automatique.
import { secrets } from '../../db/secrets';
import { ConnectorError } from '../core/errors';
import { refreshAccessToken, revokeToken, type TokenResponse } from './oauth';

/** Forme compacte (le Gestionnaire d'identification Windows limite la taille d'un secret). */
interface Bundle { a: string; e: number; r: string }

export class OAuthTokenStore {
  private mem = new Map<string, Bundle>();
  private refreshing = new Map<string, Promise<string>>();

  constructor(private prefix: string, private label: string, private onInvalid?: (id: string) => void) {}

  private key(id: string) { return this.prefix + id; }

  async load(id: string): Promise<Bundle | null> {
    const m = this.mem.get(id);
    if (m) return m;
    const raw = await secrets.get(this.key(id));
    if (!raw) return null;
    try { const b = JSON.parse(raw) as Bundle; this.mem.set(id, b); return b; } catch { return null; }
  }

  async has(id: string) { return !!(await this.load(id)); }

  async save(id: string, t: TokenResponse, fallbackRefresh?: string): Promise<void> {
    const prev = await this.load(id);
    const r = t.refresh_token ?? fallbackRefresh ?? prev?.r;
    if (!r) throw new ConnectorError('Google n’a pas fourni de jeton de rafraîchissement : retire l’accès de Prisme sur myaccount.google.com/permissions puis reconnecte-toi.');
    const b: Bundle = { a: t.access_token, e: Date.now() + Math.max(0, (t.expires_in ?? 3600) - 90) * 1000, r };
    this.mem.set(id, b);
    await secrets.set(this.key(id), JSON.stringify(b));
  }

  /** Jeton d'accès valide (rafraîchi si expiré ; un seul rafraîchissement simultané par compte). */
  async accessToken(id: string): Promise<string> {
    const b = await this.load(id);
    if (!b) throw new ConnectorError(`${this.label} : compte non connecté — Réglages → Connexions.`, { needsReauth: true });
    if (b.a && b.e > Date.now()) return b.a;
    const cur = this.refreshing.get(id);
    if (cur) return cur;
    const p = (async () => {
      try {
        const t = await refreshAccessToken(b.r);
        await this.save(id, t, b.r);
        return t.access_token;
      } catch (e) {
        if (e instanceof ConnectorError && e.info.needsReauth) this.onInvalid?.(id);
        throw e;
      } finally { this.refreshing.delete(id); }
    })();
    this.refreshing.set(id, p);
    return p;
  }

  /** Force un rafraîchissement au prochain appel (après un 401). */
  invalidate(id: string) { const b = this.mem.get(id); if (b) b.e = 0; }

  async remove(id: string, revoke = true) {
    const b = await this.load(id);
    if (revoke && b?.r) await revokeToken(b.r);
    this.mem.delete(id);
    await secrets.del(this.key(id));
  }
}
