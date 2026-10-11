// Usage: node scripts/error-report.mjs <url> [outDir]
// Opens the URL headlessly, saves screenshot.png + console.log + report.zip into outDir.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const url = process.argv[2];
if (!url) { console.error('usage: node scripts/error-report.mjs <url> [outDir]'); process.exit(1); }
const outDir = resolve(process.argv[3] || `error-report-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

const lines = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', m => lines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => lines.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
page.on('requestfailed', r => lines.push(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText || ''}`));
page.on('response', r => { if (r.status() >= 400) lines.push(`[http ${r.status()}] ${r.url()}`); });

try { await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }); }
catch (e) { lines.push(`[goto] ${e.message}`); }
await page.waitForTimeout(1000);
await page.screenshot({ path: join(outDir, 'screenshot.png'), fullPage: true });
writeFileSync(join(outDir, 'console.log'), `URL: ${url}\nDate: ${new Date().toISOString()}\n\n${lines.join('\n')}\n`);
await browser.close();

execSync(`zip -qj "${join(outDir, 'report.zip')}" "${join(outDir, 'screenshot.png')}" "${join(outDir, 'console.log')}"`);
console.log(outDir);
