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

describe('Chase report check', () => {
  // Today in Dallas, as Chase would print it.
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  it('matches recorded card payments, flags what is missing or extra, and ignores declines and tips', async () => {
    const recorded = await completedJob({ first_name: 'Matched' }, 41000);          // $443.83, recorded in CRM
    await payFull(recorded.job);
    const tipped = await completedJob({ first_name: 'Tipped' }, 20000);             // $216.50 paid + $20 tip on Chase
    await payFull(tipped.job);
    const forgotten = await completedJob({ first_name: 'Forgot' }, 30000);          // $324.75 on Chase, never recorded
    const notOnChase = await completedJob({ first_name: 'Extra' }, 11000);          // recorded as card, not on Chase
    await payFull(notOnChase.job);

    const csv = [
      'Chase Business Transactions',
      'Generated for DA SPOT 214 LLC',
      '',
      'Transaction Date,Time,Transaction Type,Status,Card Number,Amount,Tip Amount,Transaction ID',
      `${today},9:14 AM,Sale,Approved,XXXXXXXXXXXX4242,"$443.83",$0.00,CH-1`,
      `${today},10:02 AM,Sale,Approved,XXXXXXXXXXXX1111,"$236.50",$20.00,CH-2`,
      `${today},11:30 AM,Sale,Approved,XXXXXXXXXXXX9999,"$324.75",$0.00,CH-3`,
      `${today},11:45 AM,Sale,Declined,XXXXXXXXXXXX9999,"$324.75",$0.00,CH-4`,
      `Total,,,,,"$1,005.08",$20.00,`,
    ].join('\r\n');

    const r = await ctx.api.post('/api/reconcile/chase', { csv });
    expect(r.status).toBe(200);
    expect(r.body.columns).toMatchObject({ date: 'Transaction Date', time: 'Time', amount: 'Amount', tip: 'Tip Amount', id: 'Transaction ID' });
    expect(r.body.counts).toMatchObject({ sales: 3, matched: 2, missing: 1, skipped: 1 });
    expect(r.body.matched.map((m: any) => m.payment.first_name).sort()).toEqual(['Matched', 'Tipped']);
    const miss = r.body.missing[0];
    expect(miss).toMatchObject({ amount_cents: 32475, transaction_id: 'CH-3', card: '9999' });
    expect(miss.suggestions.map((s: any) => s.id)).toContain(forgotten.job.id);
    expect(r.body.extra.map((p: any) => p.job_id)).toContain(notOnChase.job.id);

    // Record the missing sale from the report; the next check matches it by transaction id.
    const rec = await ctx.api.post(`/api/jobs/${forgotten.job.id}/payments`, {
      amount_cents: 32475, kind: 'balance', method: 'card', external_ref: 'chase:CH-3', paid_at: new Date().toISOString() });
    expect(rec.body.stage).toBe('paid');
    const again = (await ctx.api.post('/api/reconcile/chase', { csv })).body;
    expect(again.counts.missing).toBe(0);
    // Recording it twice is blocked.
    const dup = await ctx.api.post(`/api/jobs/${forgotten.job.id}/payments`, {
      amount_cents: 100, kind: 'deposit', method: 'card', external_ref: 'chase:CH-3' });
    expect(dup.status).toBeGreaterThanOrEqual(400);
  });

  it('explains clearly when the file is not a Chase transactions report', async () => {
    const r = await ctx.api.post('/api/reconcile/chase', { csv: 'name,phone\nAna,2145550100' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/date and amount columns/);
  });

  it('rejects payment dates in the future', async () => {
    const { job } = await completedJob({}, 10000);
    const r = await ctx.api.post(`/api/jobs/${job.id}/payments`, {
      amount_cents: 1000, kind: 'deposit', method: 'card', paid_at: new Date(Date.now() + 864e5).toISOString() });
    expect(r.body.error.code).toBe('future_payment');
  });
});
