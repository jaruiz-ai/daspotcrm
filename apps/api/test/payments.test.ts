import { beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, setup } from './helpers.js';
import { parseCsv, parseDay, parseMinutes, parseMoney } from '../src/lib/csv.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

let slot = 0;
/** A completed job with one priced service, ready to be paid. */
async function completedJob(contact: object, cents: number, film = 'Nano Ceramic') {
  const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone(), ...contact }, vehicle: { make: 'Kia', model: 'K5' } })).body;
  const id = lead.job.id;
  await ctx.api.post(`/api/jobs/${id}/line-items`, { service: 'full_tint', shade_vlt: 35, film_product_id: ctx.film(film), unit_price_cents: cents });
  await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'quoted' });
  const start = new Date(Date.UTC(2029, 0, 1, 14) + slot++ * 3 * 3600_000);
  await ctx.api.post(`/api/jobs/${id}/appointments`, { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), bay: 9 });
  await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'in_bay' });
  const done = (await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'completed' })).body;
  return { ...lead, job: done };
}
const payFull = (job: any, method = 'card', extra: object = {}) =>
  ctx.api.post(`/api/jobs/${job.id}/payments`, { amount_cents: job.totals.balance_cents, kind: 'balance', method, ...extra });

describe('receipt text when a job is paid', () => {
  it('texts the amount and warranty numbers in English', async () => {
    const { job } = await completedJob({ first_name: 'Dana', language: 'en' }, 40000);
    const before = ctx.sender.sent.length;
    const r = await payFull(job);
    expect(r.body.stage).toBe('paid');
    const sent = ctx.sender.sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/^Thanks, Dana! We received your \$433\.00 payment for job #\d+\./);
    expect(sent[0].body).toContain(`DS-${job.number}-M1 (Nano Ceramic, lifetime)`);
    expect(sent[0].body).toMatch(new RegExp(`DS-${job.number}-L1 \\(labor, until [A-Z][a-z]{2} \\d{1,2}, \\d{4}\\)`));
  });

  it('texts in Spanish for Spanish-speaking customers, on their channel', async () => {
    const c = (await ctx.api.post('/api/contacts', { mobile: nextPhone(), first_name: 'Luis', language: 'es', preferred_channel: 'whatsapp' })).body;
    const { job } = await completedJob({ mobile: c.mobile }, 20000, 'Carbon');
    const before = ctx.sender.sent.length;
    await payFull(job, 'cash');
    const msg = ctx.sender.sent.slice(before)[0];
    expect(msg.channel).toBe('whatsapp');
    expect(msg.body).toMatch(/^¡Gracias, Luis! Recibimos su pago de \$216\.50/);
    expect(msg.body).toContain('mano de obra');
  });

  it('sends nothing for a partial payment, an opted-out customer, or a free warranty re-do', async () => {
    const { job } = await completedJob({}, 10000);
    let before = ctx.sender.sent.length;
    await ctx.api.post(`/api/jobs/${job.id}/payments`, { amount_cents: 5000, kind: 'deposit', method: 'card' });
    expect(ctx.sender.sent.length).toBe(before);

    const opted = await completedJob({}, 10000);
    await ctx.api.patch(`/api/contacts/${opted.contact.id}`, {});
    await ctx.db.query('UPDATE contacts SET sms_opt_in = false WHERE id = $1', [opted.contact.id]);
    before = ctx.sender.sent.length;
    await payFull(opted.job);
    expect(ctx.sender.sent.length).toBe(before);
  });

  it('keeps the payment and leaves a task if the text fails', async () => {
    const { job } = await completedJob({}, 10000);
    const orig = ctx.sender.send.bind(ctx.sender);
    ctx.sender.send = async () => { throw new Error('Twilio down'); };
    const r = await payFull(job);
    ctx.sender.send = orig;
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe('paid');
    const t = await ctx.db.query(`SELECT * FROM tasks WHERE subject_id = $1 AND auto_rule = 'receipt_failed'`, [job.id]);
    expect(t.rows).toHaveLength(1);
  });

  it('also texts when a prepaid job is marked completed', async () => {
    const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone(), first_name: 'Pre' }, vehicle: { make: 'Kia' } })).body;
    const id = lead.job.id;
    await ctx.api.post(`/api/jobs/${id}/line-items`, { service: 'windshield', shade_vlt: 70, film_product_id: ctx.film('Nano Ceramic'), unit_price_cents: 10000 });
    await ctx.api.post(`/api/jobs/${id}/payments`, { amount_cents: 10825, kind: 'balance', method: 'zelle' });
    await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'quoted' });
    const start = new Date(Date.UTC(2029, 5, 1, 14) + slot++ * 3 * 3600_000);
    await ctx.api.post(`/api/jobs/${id}/appointments`, { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString(), bay: 9 });
    await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'in_bay' });
    const before = ctx.sender.sent.length;
    const done = (await ctx.api.post(`/api/jobs/${id}/stage`, { to: 'completed' })).body;
    expect(done.stage).toBe('paid');
    expect(ctx.sender.sent.slice(before)[0].body).toMatch(/^Thanks, Pre!/);
  });
});

describe('CSV helpers', () => {
  it('parses quoted fields, money and US dates', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('(12.00)')).toBe(-1200);
    expect(parseMoney('-$5')).toBe(-500);
    expect(parseMoney('abc')).toBeNull();
    expect(parseDay('10/12/2026 3:04 PM')).toBe('2026-10-12');
    expect(parseDay('2026-10-12T20:00:00Z')).toBe('2026-10-12');
    expect(parseDay('Oct 12, 2026')).toBe('2026-10-12');
    expect(parseDay('02/30/2026')).toBeNull();
    expect(parseMinutes('3:04 PM')).toBe(15 * 60 + 4);
    expect(parseMinutes('12:10 AM')).toBe(10);
    expect(parseMinutes('10/12/2026 14:30')).toBe(14 * 60 + 30);
    expect(parseMinutes('none')).toBeNull();
  });
});

describe('payment dates', () => {
  it('rejects payment dates in the future', async () => {
    const { job } = await completedJob({}, 10000);
    const r = await ctx.api.post(`/api/jobs/${job.id}/payments`, {
      amount_cents: 1000, kind: 'deposit', method: 'card', paid_at: new Date(Date.now() + 864e5).toISOString() });
    expect(r.body.error.code).toBe('future_payment');
  });
});
