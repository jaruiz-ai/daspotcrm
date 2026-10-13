import { beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let slot = 0;

/** A paid job (with warranties) for a named customer. */
async function paidFor(contact: object) {
  const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone(), ...contact }, vehicle: { make: 'Lexus', model: 'RX 350', plate: `W${slot}X 100` } })).body;
  const id = lead.job.id;
  await ctx.api.post(`/api/jobs/${id}/line-items`, { service: 'full_tint', shade_vlt: 35, film_product_id: ctx.film('Carbon'), unit_price_cents: 10000 });
  await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'quoted' });
  const start = new Date(Date.UTC(2028, 0, 1, 14) + slot++ * 3 * 3600_000);
  await ctx.api.post(`/api/jobs/${id}/appointments`, { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString() });
  await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'in_bay' });
  await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'completed' });
  const paid = (await ctx.api.post(`/api/jobs/${id}/payments`, { amount_cents: 10825, kind: 'balance', method: 'card' })).body;
  expect(paid.stage).toBe('paid');
  return lead;
}

const search = async (q: string) => (await ctx.api.get(`/api/warranties/lookup?q=${encodeURIComponent(q)}`)).body as any[];

beforeAll(async () => {
  ctx = await setup();
  await paidFor({ first_name: 'Sofia', last_name: 'Ramírez', email: 'Sofia.Ramirez@Example.com' });
  await paidFor({ first_name: 'Sofian', last_name: 'Ortega', email: 'sortega@example.com' });
  await paidFor({ first_name: 'Mark', last_name: 'Lee', email: 'mark_lee@example.com' });
});

describe('warranty search by name and email', () => {
  it('finds by full name, either order, any case, with or without accents', async () => {
    for (const q of ['Sofia Ramírez', 'ramírez sofia', 'SOFIA RAMÍREZ', 'Sofia Ramirez', 'ramirez']) {
      const r = await search(q);
      expect(r.length).toBeGreaterThan(0);
      expect(r.every((w) => w.last_name === 'Ramírez')).toBe(true);
    }
  });

  it('finds by part of a name and returns everyone who matches', async () => {
    const r = await search('Sofi');
    expect(new Set(r.map((w) => w.last_name))).toEqual(new Set(['Ramírez', 'Ortega']));
  });

  it('finds by email, ignoring case, and returns the email for display', async () => {
    const r = await search('sofia.ramirez@example.COM');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((w) => w.email === 'Sofia.Ramirez@Example.com')).toBe(true);
  });

  it('needs the whole email, so a partial address does not leak other customers', async () => {
    expect(await search('@example.com')).toEqual([]);
  });

  it('treats _ and % as literal characters', async () => {
    expect((await search('mark_lee@example.com')).length).toBeGreaterThan(0);
    expect(await search('s_f')).toEqual([]);
    expect(await search('%%%')).toEqual([]);
  });

  it('does not let a plate search match names', async () => {
    expect(await search('LEE1234')).toEqual([]);
  });

  it('still rejects searches shorter than 3 characters', async () => {
    expect((await ctx.api.get('/api/warranties/lookup?q=so')).status).toBe(400);
  });
});
