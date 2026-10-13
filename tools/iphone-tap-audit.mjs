// iPhone tap-safety audit: run against the built app (see README). Needs puppeteer-core + @sparticuz/chromium.
// Screenshots of the real production build at iPhone size, with demo customers.
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const PORT = 4400;
const BASE = `http://localhost:${PORT}`;
// The browser uses a live-looking address so the screens match production (no local-only hints).
const WEB = `http://admin.daspot214.test:${PORT}`;
mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['/home/claude/daspot-crm/apps/api/dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), TZ: 'America/Chicago' }, stdio: 'inherit',
});
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const call = async (p, body, method = 'POST') => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${JSON.stringify(j)}`);
  return j;
};
const at = (days, hour, min = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, min, 0, 0); return d.toISOString(); };
const film = Object.fromEntries((await call('/film-products', undefined, 'GET')).map((f) => [f.line, f.id]));
const lead = async (first, last, mobile, lang, v, source, email) =>
  (await call('/leads', { contact: { first_name: first, last_name: last, mobile, language: lang, email }, vehicle: v ?? undefined, lead_source: source })).job.id;
const line = (id, b) => call(`/jobs/${id}/line-items`, b);
const stage = (id, to) => call(`/jobs/${id}/stage`, { to });

await lead('Ana', 'Gutierrez', '2145550142', 'es', { year: 2021, make: 'Honda', model: 'Civic' }, 'instagram');
await lead('Derek', 'Lewis', '4695550188', 'en', { year: 2024, make: 'Ford', model: 'Bronco' }, 'website');
await fetch(`${BASE}/webhooks/twilio/inbound`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ From: 'whatsapp:+19725550117', Body: 'cuanto por polarizar mi silverado 2019 al 15', MessageSid: 'SMdemo1' }) });

const priya = await lead('Priya', 'Shah', '2145550163', 'en', { year: 2023, make: 'Tesla', model: 'Model Y' }, 'tiktok');
await line(priya, { service: 'full_tint', shade_vlt: 35, film_product_id: film['Nano Ceramic'], unit_price_cents: 45000 });
await line(priya, { service: 'pano_roof', shade_vlt: 70, film_product_id: film['Nano Ceramic'], unit_price_cents: 15000 });
await stage(priya, 'quoted');
const luis = await lead('Luis', 'Ortega', '9725550134', 'es', { year: 2020, make: 'Chevrolet', model: 'Tahoe' }, 'referral');
await line(luis, { service: 'full_tint', shade_vlt: 20, film_product_id: film['Carbon-Ceramic'], unit_price_cents: 34000 });
await stage(luis, 'quoted');

const marcus = await lead('Marcus', 'Reed', '2145550109', 'en', { year: 2022, make: 'Dodge', model: 'Charger' }, 'instagram');
await line(marcus, { service: 'full_tint', shade_vlt: 35, film_product_id: film['Carbon-Ceramic'], unit_price_cents: 32000 });
await stage(marcus, 'quoted');
await call(`/jobs/${marcus}/appointments`, { starts_at: at(2, 10), ends_at: at(2, 12, 30), bay: 1 });
await call(`/jobs/${marcus}/payments`, { amount_cents: 5000, kind: 'deposit', method: 'card' });

const carlos = await lead('Carlos', 'Mendez', '4695550176', 'es', { year: 2019, make: 'Toyota', model: 'Tacoma', plate: 'LKP 4821' }, 'text');
await line(carlos, { service: 'full_tint', shade_vlt: 20, film_product_id: film['Carbon-Ceramic'], unit_price_cents: 30000 });
await line(carlos, { service: 'windshield', shade_vlt: 70, film_product_id: film['Nano Ceramic'], unit_price_cents: 22000 });
await line(carlos, { service: 'removal', unit_price_cents: 8000, description: 'Rear glass, old purple film' });
await stage(carlos, 'quoted');
await call(`/jobs/${carlos}/appointments`, { starts_at: at(0, 9), ends_at: at(0, 13), bay: 2 });
await call(`/jobs/${carlos}/payments`, { amount_cents: 10000, kind: 'deposit', method: 'zelle' });
await stage(carlos, 'in_bay');

const julian = await lead('Julian', 'Moore', '2145550151', 'en', { year: 2024, make: 'BMW', model: 'M340i' }, 'funnel');
await line(julian, { service: 'chrome_delete', unit_price_cents: 45000 });
await line(julian, { service: 'lights', unit_price_cents: 15000, description: 'Tail lights, smoke' });
await stage(julian, 'quoted');
await call(`/jobs/${julian}/appointments`, { starts_at: at(-1, 13), ends_at: at(-1, 17), bay: 1 });
await call(`/jobs/${julian}/payments`, { amount_cents: 20000, kind: 'deposit', method: 'card' });
await stage(julian, 'in_bay');
await stage(julian, 'completed');

const sofia = await lead('Sofia', 'Ramirez', '9725550192', 'en', { year: 2023, make: 'Lexus', model: 'RX 350', plate: 'RHT 2290' }, 'website', 'sofia.ramirez@gmail.com');
await line(sofia, { service: 'full_tint', shade_vlt: 35, film_product_id: film['Nano Ceramic'], unit_price_cents: 48000 });
await line(sofia, { service: 'sun_strip', shade_vlt: 15, film_product_id: film['Carbon'], unit_price_cents: 4000 });
await stage(sofia, 'quoted');
await call(`/jobs/${sofia}/appointments`, { starts_at: at(-3, 10), ends_at: at(-3, 12), bay: 1 });
await stage(sofia, 'in_bay');
await stage(sofia, 'completed');
await call(`/jobs/${sofia}/payments`, { amount_cents: 56290, kind: 'balance', method: 'affirm' });

// Local copies of the app's fonts (the sandbox can't reach Google Fonts).
const fontDir = path.resolve('node_modules/@fontsource');
const face = (family, file, weight) => `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${readFileSync(path.join(fontDir, file)).toString('base64')}) format('woff2');}`;
const fontCss = [
  face('Barlow', 'barlow/files/barlow-latin-400-normal.woff2', 400),
  face('Barlow', 'barlow/files/barlow-latin-500-normal.woff2', 500),
  face('Barlow', 'barlow/files/barlow-latin-600-normal.woff2', 600),
  face('Barlow Condensed', 'barlow-condensed/files/barlow-condensed-latin-500-normal.woff2', 500),
  face('Barlow Condensed', 'barlow-condensed/files/barlow-condensed-latin-600-normal.woff2', 600),
  face('Barlow Condensed', 'barlow-condensed/files/barlow-condensed-latin-700-normal.woff2', 700),
].join('\n');


// ---------------- tap-safety audit ----------------
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, '--font-render-hinting=none', `--host-resolver-rules=MAP admin.daspot214.test 127.0.0.1`],
  headless: true,
});
const page = await browser.newPage();
await page.emulateTimezone('America/Chicago');
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.startsWith('https://fonts.googleapis.com')) return req.respond({ status: 200, contentType: 'text/css', body: fontCss });
  if (!u.startsWith(WEB) && !u.startsWith('data:')) return req.abort();
  req.continue();
});
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));

const DEVICES = [
  { name: 'iPhone SE', width: 375, height: 667, sab: 0, sat: 0 },
  { name: 'iPhone 15 Pro', width: 393, height: 852, sab: 34, sat: 0 },
];
const SAFE_CSS = (d) => `:root{--sab:${d.sab}px !important;--sat:${d.sat}px !important;--sal:0px !important;--sar:0px !important}`;

const go = async (hash, waitFor, d) => {
  await page.goto(`${WEB}/${hash}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.addStyleTag({ content: SAFE_CSS(d) });
  if (waitFor) await page.waitForFunction((t) => document.body.innerText.includes(t), {}, waitFor);
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 150));
};

/** Runs in the page: finds small targets, overlapping targets, and targets stuck under fixed bars. */
const AUDIT = (sab) => {
  const vh = window.innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    for (let p = el; p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.open && !el.closest('summary')) {
        if (p !== el && !p.querySelector(':scope > summary')?.contains(el)) return false;
      }
    }
    return true;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  // A finger only reaches what is on top at its center point (a modal sheet blocks what is behind it).
  const reachable = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
    const modal = document.querySelector('[aria-modal=true]');
    // Off screen: reachable by scrolling, unless a modal has locked scrolling and the element is behind it.
    if (r.bottom < 0 || r.top > window.innerHeight) return !(modal && !modal.contains(el) && getComputedStyle(document.body).overflow === 'hidden');
    const hit = document.elementFromPoint(x, y);
    return !!hit && (el === hit || el.contains(hit) || hit.contains(el) || (el.tagName === 'INPUT' && hit.closest('label') === el.closest('label')));
  };
  const blocked = [];
  const targets = [...document.querySelectorAll('a[href], button, input:not([type=file]), select, textarea, summary, .file-pick .btn')]
    .filter((el) => visible(el) && !(el.tagName === 'INPUT' && el.closest('label.file-pick')))
    .filter((el) => { const ok = reachable(el); if (!ok) blocked.push(el); return ok; });
  // Inline text links inside sentences are exempt from the 44pt rule (Apple allows them), but not from overlap.
  const isInlineText = (el) => el.tagName === 'A' && getComputedStyle(el).display === 'inline' && !el.classList.contains('btn');
  const fixed = [...document.querySelectorAll('body *')].filter((el) => {
    const p = getComputedStyle(el).position;
    return (p === 'fixed' || p === 'sticky') && visible(el);
  });
  const inFixed = (el) => fixed.some((f) => f.contains(el));
  const issues = [];
  // Report anything a modal does NOT cover but should (only meaningful while a dialog is open).
  const dialog = document.querySelector('[aria-modal=true]');
  if (dialog) for (const el of targets) if (!dialog.contains(el)) issues.push({ type: 'not-blocked-by-sheet', what: label(el) });
  const hitBox = (el) => (el.matches('input[type=checkbox],input[type=radio]') && el.closest('label') ? el.closest('label') : el).getBoundingClientRect();
  for (const el of targets) {
    const r = hitBox(el);
    if (!isInlineText(el) && el.tagName !== 'SUMMARY' && (r.height < 43.5 || r.width < 43.5)) {
      issues.push({ type: 'small', what: label(el), size: `${Math.round(r.width)}x${Math.round(r.height)}` });
    }
  }
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    const a = targets[i], b = targets[j];
    if (a.contains(b) || b.contains(a)) continue;
    if (a.closest('label') && a.closest('label') === b.closest('label')) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 1 && h > 1 && !(inFixed(a) !== inFixed(b))) issues.push({ type: 'overlap', what: `${label(a)} / ${label(b)}` });
    // Too close: under 8pt apart edge to edge, side by side or stacked.
    else if (!(inFixed(a) !== inFixed(b))) {
      const gapX = Math.max(ra.left, rb.left) - Math.min(ra.right, rb.right);
      const gapY = Math.max(ra.top, rb.top) - Math.min(ra.bottom, rb.bottom);
      const small = (r, dim) => (dim === 'w' ? r.width : r.height) < 48;
      const sideBySide = h > 4 && gapX >= 0 && gapX < 6 && (small(ra, 'w') || small(rb, 'w'));
      const stacked = w > 4 && gapY >= 0 && gapY < 6 && (small(ra, 'h') || small(rb, 'h'));
      if ((sideBySide || stacked) && !isInlineText(a) && !isInlineText(b)) issues.push({ type: 'too-close', what: `${label(a)} / ${label(b)}`, gap: Math.round(sideBySide ? gapX : gapY) });
    }
  }
  // At the bottom of the page, nothing may be stuck under bottom bars or the home indicator.
  window.scrollTo(0, document.documentElement.scrollHeight);
  const bottomBars = fixed.filter((f) => { const r = f.getBoundingClientRect(); return r.bottom >= vh - 2 && r.top > vh / 2; });
  const coverTop = Math.min(vh - sab, ...bottomBars.map((f) => f.getBoundingClientRect().top));
  for (const el of targets) {
    if (inFixed(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > coverTop + 1 && r.top < vh) issues.push({ type: 'covered', what: label(el), by: Math.round(r.bottom - coverTop) });
  }
  // Bars that sit under the home indicator.
  for (const f of bottomBars) {
    for (const el of [...f.querySelectorAll('a,button')].filter(visible)) {
      const r = el.getBoundingClientRect();
      if (r.bottom > vh - sab + 1) issues.push({ type: 'under-home-bar', what: label(el) });
    }
  }
  window.scrollTo(0, 0);
  return issues;
};

const screens = [
  ['Pipeline', '#/', 'Gutierrez', null],
  ['Job in the bay', `#/jobs/${carlos}`, 'Texas 25%', null],
  ['Job More menu', `#/jobs/${carlos}`, 'Texas 25%', async () => { await page.evaluate(() => document.querySelector('details.more')?.setAttribute('open', '')); }],
  ['Job awaiting payment', `#/jobs/${julian}`, 'Paid by card', null],
  ['Payment confirmation', `#/jobs/${julian}`, 'Paid by card', async () => {
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Paid by card')).click());
    await page.waitForSelector('[role=dialog]');
  }],
  ['Typing in a field', `#/jobs/${carlos}`, 'Texas 25%', async () => { await page.focus('#waiver-name'); }],
  ['Job quoted', `#/jobs/${priya}`, 'Mark booked', null],
  ['Paid job', `#/jobs/${sofia}`, 'Warranties', null],
  ['New lead', '#/new', 'Customer', null],
  ['Warranties', '#/warranty', 'Import past clients', async () => {
    await page.type('#warranty-q', 'Sofia Ramirez'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.innerText.includes('DS-'));
    await page.evaluate(() => document.activeElement?.blur());
  }],
  ['Import preview', '#/import', 'Import past clients', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${process.argv[2]}/a.csv`, 'Name,Phone,Install Date,Film\nRosa D,2145550201,3/15/2025,Carbon\nNo Phone,,1/1/2024,Carbon');
    const input = await page.$('#import-file'); await input.uploadFile(`${process.argv[2]}/a.csv`);
    await page.waitForFunction(() => document.body.innerText.includes('rows to check'));
  }],
];

await page.goto(`${WEB}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('daspot.staffToken', 'dev-token'));
const report = {};
for (const d of DEVICES) {
  await page.setViewport({ width: d.width, height: d.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  for (const [name, hash, wait, prep] of screens) {
    await go(hash, wait, d);
    if (prep) await prep();
    await new Promise((r) => setTimeout(r, 150));
    const issues = await page.evaluate(AUDIT, d.sab);
    const key = `${d.name} | ${name}`;
    const seen = new Set();
    report[key] = issues.filter((i) => { const k = JSON.stringify(i); if (seen.has(k)) return false; seen.add(k); return true; });
  }
}
let total = 0;
for (const [k, v] of Object.entries(report)) {
  total += v.length;
  console.log(`${v.length ? 'FAIL' : 'ok  '} ${k}${v.length ? '' : ''}`);
  for (const i of v) console.log(`       ${i.type.padEnd(14)} ${i.what}${i.size ? ` (${i.size})` : ''}${i.gap != null ? ` (gap ${i.gap})` : ''}${i.by ? ` (${i.by}pt covered)` : ''}`);
}
console.log(`TOTAL ISSUES ${total}`);
await browser.close();
stop();
process.exit(0);
