// Renders each screen with demo data and writes its HTML to SCREEN_OUT. Not part of the normal test run.
import { afterAll, beforeAll, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import App from '../src/App';
import { createApp } from '../../api/src/app';
import { createMemoryDb, migrate, type Db } from '../../api/src/db/index';
import { seed } from '../../api/src/db/seed';
import { FakeSender } from '../../api/src/lib/messaging';

const OUT = process.env.SCREEN_OUT!;
let server: Server;
let db: Db;
const realFetch = globalThis.fetch;
const H = { authorization: 'Bearer demo', 'content-type': 'application/json' };
const call = async (path: string, body?: object, method = 'POST') => {
  const r = await fetch(`/api${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j;
};

/** innerHTML drops live form values, so copy them into attributes first. */
function snapshot(name: string) {
  const root = document.body.firstElementChild as HTMLElement;
  root.querySelectorAll('input').forEach((el) => el.setAttribute('value', el.value));
  root.querySelectorAll('textarea').forEach((el) => { el.textContent = el.value; });
  root.querySelectorAll('select').forEach((el) => el.querySelectorAll('option').forEach((o) => {
    if (o.selected) o.setAttribute('selected', ''); else o.removeAttribute('selected');
  }));
  writeFileSync(`${OUT}/${name}.html`, root.innerHTML);
}

const at = (daysFromNow: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

let film: Record<string, string> = {};
let ids: Record<string, string> = {};

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  db = await createMemoryDb();
  await migrate(db);
  await seed(db);
  const app = createApp({ db, sender: new FakeSender(), config: { staffToken: 'demo', twilioAuthToken: '', publicBaseUrl: '' } });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(url.startsWith('http') ? url : base + url, init)) as typeof fetch;
  film = Object.fromEntries((await call('/film-products', undefined, 'GET')).map((f: any) => [f.line, f.id]));

  const lead = async (first: string, last: string, mobile: string, lang: string, v: object | null, source: string) =>
    (await call('/leads', { contact: { first_name: first, last_name: last, mobile, language: lang }, vehicle: v ?? undefined, lead_source: source })).job.id;
  const line = (id: string, b: object) => call(`/jobs/${id}/line-items`, b);
  const stage = (id: string, to: string) => call(`/jobs/${id}/stage`, { to });

  // New leads
  await lead('Ana', 'Gutierrez', '2145550142', 'es', { year: 2021, make: 'Honda', model: 'Civic' }, 'instagram');
  await lead('Derek', 'Lewis', '4695550188', 'en', { year: 2024, make: 'Ford', model: 'Bronco' }, 'website');
  await realFetch(`${base}/webhooks/twilio/inbound`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: 'whatsapp:+19725550117', Body: 'cuanto por polarizar mi silverado 2019 al 15', MessageSid: 'SMdemo1' }) });

  // Quoted
  const priya = await lead('Priya', 'Shah', '2145550163', 'en', { year: 2023, make: 'Tesla', model: 'Model Y' }, 'tiktok');
  await line(priya, { service: 'full_tint', shade_vlt: 35, film_product_id: film['Nano Ceramic'], unit_price_cents: 45000 });
  await line(priya, { service: 'pano_roof', shade_vlt: 70, film_product_id: film['Nano Ceramic'], unit_price_cents: 15000 });
  await stage(priya, 'quoted');
  const luis = await lead('Luis', 'Ortega', '9725550134', 'es', { year: 2020, make: 'Chevrolet', model: 'Tahoe' }, 'referral');
  await line(luis, { service: 'full_tint', shade_vlt: 20, film_product_id: film['Carbon-Ceramic'], unit_price_cents: 34000 });
  await stage(luis, 'quoted');
  await db.query(`UPDATE jobs SET updated_at = now() - interval '4 days' WHERE id = $1`, [luis]);

  // Booked
  const marcus = await lead('Marcus', 'Reed', '2145550109', 'en', { year: 2022, make: 'Dodge', model: 'Charger' }, 'instagram');
  await line(marcus, { service: 'full_tint', shade_vlt: 35, film_product_id: film['Carbon-Ceramic'], unit_price_cents: 32000 });
  await stage(marcus, 'quoted');
  await call(`/jobs/${marcus}/appointments`, { starts_at: at(2, 10), ends_at: at(2, 12, 30), bay: 1 });
  await call(`/jobs/${marcus}/payments`, { amount_cents: 5000, kind: 'deposit', method: 'card' });

  // In the bay — needs the Texas waiver (20% fronts)
  const carlos = await lead('Carlos', 'Mendez', '4695550176', 'es', { year: 2019, make: 'Toyota', model: 'Tacoma', plate: 'LKP 4821' }, 'text');
  await line(carlos, { service: 'full_tint', shade_vlt: 20, film_product_id: film['Carbon-Ceramic'], unit_price_cents: 30000 });
  await line(carlos, { service: 'windshield', shade_vlt: 70, film_product_id: film['Nano Ceramic'], unit_price_cents: 22000 });
  await line(carlos, { service: 'removal', unit_price_cents: 8000, description: 'Rear glass, old purple film' });
  await stage(carlos, 'quoted');
  await call(`/jobs/${carlos}/appointments`, { starts_at: at(0, 9), ends_at: at(0, 13), bay: 2 });
  await call(`/jobs/${carlos}/payments`, { amount_cents: 10000, kind: 'deposit', method: 'zelle' });
  await stage(carlos, 'in_bay');
  ids.carlos = carlos;

  // Completed, balance due
  const julian = await lead('Julian', 'Moore', '2145550151', 'en', { year: 2024, make: 'BMW', model: 'M340i' }, 'funnel');
  await line(julian, { service: 'chrome_delete', unit_price_cents: 45000 });
  await line(julian, { service: 'lights', unit_price_cents: 15000, description: 'Tail lights, smoke' });
  await stage(julian, 'quoted');
  await call(`/jobs/${julian}/appointments`, { starts_at: at(-1, 13), ends_at: at(-1, 17), bay: 1 });
  await call(`/jobs/${julian}/payments`, { amount_cents: 20000, kind: 'deposit', method: 'card' });
  await stage(julian, 'in_bay');
  await stage(julian, 'completed');

  // Paid with warranties
  const sofia = await lead('Sofia', 'Ramirez', '9725550192', 'en', { year: 2023, make: 'Lexus', model: 'RX 350', plate: 'RHT 2290' }, 'website');
  await line(sofia, { service: 'full_tint', shade_vlt: 35, film_product_id: film['Nano Ceramic'], unit_price_cents: 48000 });
  await line(sofia, { service: 'sun_strip', shade_vlt: 15, film_product_id: film['Carbon'], unit_price_cents: 4000 });
  await stage(sofia, 'quoted');
  await call(`/jobs/${sofia}/appointments`, { starts_at: at(-3, 10), ends_at: at(-3, 12), bay: 1 });
  await stage(sofia, 'in_bay');
  await stage(sofia, 'completed');
  await call(`/jobs/${sofia}/payments`, { amount_cents: 56290, kind: 'balance', method: 'affirm' });
  ids.sofia = sofia;
  await db.query(`UPDATE contacts SET email = 'sofia.ramirez@gmail.com' WHERE mobile = '+19725550192'`);
});

afterAll(async () => { globalThis.fetch = realFetch; server?.close(); await db?.close(); });

const go = (hash: string) => { cleanup(); localStorage.setItem('daspot.staffToken', 'demo'); location.hash = hash; render(<App />); };

it('captures screens', async () => {
  cleanup(); localStorage.clear(); location.hash = '#/'; render(<App />);
  await screen.findByLabelText('Shop access code');
  snapshot('login');

  go('#/');
  await screen.findByText('Sofia Ramirez');
  snapshot('board');

  go('#/new');
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Mobile'), '(214) 555-0127');
  await user.type(screen.getByLabelText('First name'), 'Rosa');
  await user.type(screen.getByLabelText('Last name'), 'Delgado');
  await user.selectOptions(screen.getByLabelText('Language'), 'es');
  await user.type(screen.getByLabelText('Year'), '2022');
  await user.type(screen.getByLabelText('Make'), 'Nissan');
  await user.type(screen.getByLabelText('Model'), 'Altima');
  await user.selectOptions(screen.getByLabelText('How they found us'), 'instagram');
  await user.type(screen.getByLabelText('Note'), 'Wants 35% all around, asked about ceramic for the heat');
  snapshot('new-lead');

  go(`#/jobs/${ids.carlos}`);
  await screen.findByText(/below the Texas 25% limit/);
  await screen.findAllByText('Nano Ceramic');
  snapshot('job-in-bay');

  go(`#/jobs/${ids.sofia}`);
  await screen.findByRole('heading', { name: 'Warranties' });
  snapshot('job-paid');

  go('#/warranty');
  await user.type(await screen.findByLabelText(/Name, phone, email, plate/), 'Sofia Ramirez');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => screen.getAllByText(/^DS-\d+-(M\d|L1)$/));
  snapshot('warranty');
});
