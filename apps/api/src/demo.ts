import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Db } from './db/index.js';

/**
 * Sample customers for the test site, created through the app's own API so every
 * business rule (totals, stages, warranties) applies exactly as it would for real jobs.
 * Runs only when the database has no jobs yet.
 */
export async function loadDemoData(db: Db, app: Express, staffToken: string): Promise<void> {
  const has = await db.query('SELECT 1 FROM jobs LIMIT 1');
  if (has.rows[0]) return;

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };
  const call = async (path: string, body?: object, method = 'POST') => {
    const r = await fetch(`${base}/api${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`demo ${path}: ${JSON.stringify(j)}`);
    return j;
  };
  // Shop-local (Dallas) times, so bookings land on sensible hours whatever the server's clock zone.
  const at = (daysFromNow: number, hour: number, minute = 0) => {
    const day = new Date(Date.now() + daysFromNow * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const probe = new Date(`${day}T12:00:00Z`);
    const offsetH = 12 - Number(probe.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
    return new Date(Date.parse(`${day}T00:00:00Z`) + ((hour + offsetH) * 60 + minute) * 6e4).toISOString();
  };

  try {
    const film: Record<string, string> = Object.fromEntries(
      (await call('/film-products', undefined, 'GET')).map((f: { line: string; id: string }) => [f.line, f.id]),
    );
    const lead = async (first: string, last: string, mobile: string, lang: string, v: object, source: string) =>
      (await call('/leads', { contact: { first_name: first, last_name: last, mobile, language: lang }, vehicle: v, lead_source: source })).job.id as string;
    const line = (id: string, b: object) => call(`/jobs/${id}/line-items`, b);
    const stage = (id: string, to: string) => call(`/jobs/${id}/stage`, { to });

    // New leads
    await lead('Ana', 'Gutierrez', '2145550142', 'es', { year: 2021, make: 'Honda', model: 'Civic' }, 'instagram');
    await lead('Derek', 'Lewis', '4695550188', 'en', { year: 2024, make: 'Ford', model: 'Bronco' }, 'website');
    await fetch(`${base}/webhooks/twilio/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: 'whatsapp:+19725550117', Body: 'cuanto por polarizar mi silverado 2019 al 15', MessageSid: 'SMdemo1' }),
    });

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

    // Booked for later today, through Add appointment
    await call('/appointments', {
      contact: { mobile: '2145556120', first_name: 'Rosa', last_name: 'Delgado', language: 'es' },
      vehicle: { year: 2022, make: 'Nissan', model: 'Altima' },
      service: 'full_tint', price_cents: 30000, note: 'Wants 35% all around',
      slot: { starts_at: at(0, 14), ends_at: at(0, 16), bay: 1 },
    });
    await call('/appointments', {
      contact: { mobile: '4695550133', first_name: 'Kevin', last_name: 'Tran' },
      vehicle: { year: 2024, make: 'Toyota', model: 'Camry' },
      service: 'windshield', price_cents: 22000,
      slot: { starts_at: at(0, 16, 30), ends_at: at(0, 17, 30), bay: 3 },
    });

    // In the bay — 20% fronts, so the Texas waiver is still needed
    const carlos = await lead('Carlos', 'Mendez', '4695550176', 'es', { year: 2019, make: 'Toyota', model: 'Tacoma', plate: 'LKP 4821' }, 'text');
    await line(carlos, { service: 'full_tint', shade_vlt: 20, film_product_id: film['Carbon-Ceramic'], unit_price_cents: 30000 });
    await line(carlos, { service: 'windshield', shade_vlt: 70, film_product_id: film['Nano Ceramic'], unit_price_cents: 22000 });
    await line(carlos, { service: 'removal', unit_price_cents: 8000, description: 'Rear glass, old purple film' });
    await stage(carlos, 'quoted');
    await call(`/jobs/${carlos}/appointments`, { starts_at: at(0, 9), ends_at: at(0, 13), bay: 2 });
    await call(`/jobs/${carlos}/payments`, { amount_cents: 10000, kind: 'deposit', method: 'zelle' });
    await stage(carlos, 'in_bay');

    // Completed, balance due
    const julian = await lead('Julian', 'Moore', '2145550151', 'en', { year: 2024, make: 'BMW', model: 'M340i' }, 'funnel');
    await line(julian, { service: 'chrome_delete', unit_price_cents: 45000 });
    await line(julian, { service: 'lights', unit_price_cents: 15000, description: 'Tail lights, smoke' });
    await stage(julian, 'quoted');
    await call(`/jobs/${julian}/appointments`, { starts_at: at(-1, 13), ends_at: at(-1, 17), bay: 1 });
    await call(`/jobs/${julian}/payments`, { amount_cents: 20000, kind: 'deposit', method: 'card' });
    await stage(julian, 'in_bay');
    await stage(julian, 'completed');

    // Paid, with warranties issued
    const sofia = await lead('Sofia', 'Ramirez', '9725550192', 'en', { year: 2023, make: 'Lexus', model: 'RX 350', plate: 'RHT 2290' }, 'website');
    await line(sofia, { service: 'full_tint', shade_vlt: 35, film_product_id: film['Nano Ceramic'], unit_price_cents: 48000 });
    await line(sofia, { service: 'sun_strip', shade_vlt: 15, film_product_id: film['Carbon'], unit_price_cents: 4000 });
    await stage(sofia, 'quoted');
    await call(`/jobs/${sofia}/appointments`, { starts_at: at(-3, 10), ends_at: at(-3, 12), bay: 1 });
    await stage(sofia, 'in_bay');
    await stage(sofia, 'completed');
    await call(`/jobs/${sofia}/payments`, { amount_cents: 56290, kind: 'balance', method: 'card' });
    await db.query(`UPDATE contacts SET email = 'sofia.ramirez@gmail.com' WHERE mobile = '+19725550192'`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
