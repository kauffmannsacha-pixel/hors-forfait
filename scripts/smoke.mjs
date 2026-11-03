// Test de fumée : lance l'app en mode navigateur (vite preview) et parcourt chaque vue.
// Usage : npm run build && node scripts/smoke.mjs [dossier-captures]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'smoke-shots';
mkdirSync(out, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'pipe' });
await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('4173') && res()));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
await page.goto('http://localhost:4173/?debug');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/00-accueil.png` });

const views = ['studio', 'scripts', 'stats', 'miniatures', 'titres', 'publication', 'mail', 'fichiers', 'connaissances', 'calendrier'];
for (const [i, v] of views.entries()) {
  const ok = await page.evaluate((id) => { const p = (window).__prisme; if (p?.openView) { p.openView(id); return true; } return false; }, v);
  if (!ok) {
    const link = page.locator(`[data-view="${v}"]`).first();
    if (await link.count()) await link.click(); else { errors.push(`vue introuvable : ${v}`); continue; }
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${String(i + 1).padStart(2, '0')}-${v}.png` });
}
await browser.close();
server.kill();
console.log(errors.length ? 'ERREURS:\n' + errors.join('\n') : 'Aucune erreur console.');
process.exit(errors.length ? 1 : 0);
