import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { nextPhone, setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createMemoryDb, migrate, type Db } from '../src/db/index.js';
import { FakeSender } from '../src/lib/messaging.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

describe('second bug pass', () => {
  it('BUG 6: editing one contact field resets language, reply channel and tags', async () => {
    const c = (await ctx.api.post('/api/contacts', {
      mobile: nextPhone(), language: 'es', preferred_channel: 'whatsapp', tags: ['VIP'] })).body;
    const r = await ctx.api.patch(`/api/contacts/${c.id}`, { first_name: 'Rosa' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ first_name: 'Rosa', language: 'es', preferred_channel: 'whatsapp', tags: ['VIP'] });
  });

  it('BUG 7: the job page shows an expired warranty as active', async () => {
    const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone() }, vehicle: { make: 'Kia' } })).body;
    await ctx.api.post(`/api/jobs/${lead.job.id}/line-items`, { service: 'full_tint', film_product_id: ctx.film('Carbon'), unit_price_cents: 100 });
    await ctx.db.query(`UPDATE jobs SET stage = 'completed', completed_at = now() - interval '6 years' WHERE id = $1`, [lead.job.id]);
    await ctx.api.post(`/api/jobs/${lead.job.id}/payments`, { amount_cents: 108, kind: 'balance', method: 'cash' });
    const job = (await ctx.api.get(`/api/jobs/${lead.job.id}`)).body;
    const mfr = job.warranties.find((w: any) => w.coverage === 'manufacturer');
    expect(mfr.in_term).toBe(false);
  });

  it('BUG 8: a returning customer entered twice gets a duplicate car', async () => {
    const mobile = nextPhone();
    const v = { year: 2020, make: 'Ford', model: 'F-150' };
    const a = (await ctx.api.post('/api/leads', { contact: { mobile }, vehicle: v })).body;
    const b = (await ctx.api.post('/api/leads', { contact: { mobile }, vehicle: { ...v, make: 'ford' } })).body;
    expect(b.vehicle.id).toBe(a.vehicle.id);
  });

  it('BUG 9: a processor fee larger than the payment is accepted', async () => {
    const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone() }, vehicle: { make: 'Kia' } })).body;
    await ctx.api.post(`/api/jobs/${lead.job.id}/line-items`, { service: 'sun_strip', unit_price_cents: 5000 });
    const r = await ctx.api.post(`/api/jobs/${lead.job.id}/payments`, { amount_cents: 1000, kind: 'deposit', method: 'card', processor_fee_cents: 5000 });
    expect(r.status).toBe(400);
  });

  it('BUG 10: in production nothing serves the web app', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    const db = await createMemoryDb();
    await migrate(db);
    const app = createApp({ db, sender: new FakeSender(), config: { staffToken: 't', twilioAuthToken: '', publicBaseUrl: '', webDir: dir } as any });
    const home = await request(app).get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('id="root"');
    expect((await request(app).get('/assets/app.js')).status).toBe(200);
    // API routes still win, and unknown API paths are still JSON 404s.
    expect((await request(app).get('/api/nope').set('authorization', 'Bearer t')).status).toBe(404);
    expect((await request(app).get('/health')).body).toEqual({ ok: true });
  });

  it('BUG 11: a migration that fails halfway leaves a half-built database', async () => {
    const db: Db = await createMemoryDb();
    await migrate(db);
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    // Copy the real migrations, then add a broken one.
    const real = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/db/migrations');
    for (const f of readdirSync(real)) writeFileSync(path.join(dir, f), readFileSync(path.join(real, f)));
    writeFileSync(path.join(dir, '999_broken.sql'), 'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;');
    await expect(migrate(db, dir)).rejects.toThrow();
    const t = await db.query(`SELECT to_regclass('half_done') AS t`);
    expect(t.rows[0].t).toBeNull();
  });
});
