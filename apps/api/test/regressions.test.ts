import { beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

const move = (id: string, to: string, extra: object = {}) => ctx.api.post(`/api/jobs/${id}/stage`, { to, ...extra });
let slot = 0;
const nextSlot = (bay = 5) => {
  const start = new Date(Date.UTC(2027, 5, 1, 14) + slot++ * 3 * 3600_000);
  return { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 2 * 3600_000).toISOString(), bay };
};

async function completedJob(lines: number[]) {
  const lead = (await ctx.api.post('/api/leads', {
    contact: { mobile: nextPhone() }, vehicle: { year: 2021, make: 'Honda', model: 'Civic' } })).body;
  let detail: any;
  for (const cents of lines) {
    detail = (await ctx.api.post(`/api/jobs/${lead.job.id}/line-items`, { service: 'other', unit_price_cents: cents })).body;
  }
  await move(lead.job.id, 'quoted');
  await ctx.api.post(`/api/jobs/${lead.job.id}/appointments`, nextSlot());
  await move(lead.job.id, 'in_bay');
  const done = (await move(lead.job.id, 'completed')).body;
  return { ...lead, detail, done };
}

describe('regressions found in code review', () => {
  it('BUG 1: a completed job whose balance is cleared by a price change gets stuck short of Paid', async () => {
    const { job, done } = await completedJob([10000, 5000]);
    const total = done.totals.total_cents; // 150.00 + tax
    const firstLineTotal = Math.round(10000 * 1.0825);
    await ctx.api.post(`/api/jobs/${job.id}/payments`, { amount_cents: firstLineTotal, kind: 'balance', method: 'cash' });
    const small = done.line_items.find((l: any) => l.unit_price_cents === 5000);
    // Customer declines the small add-on after paying for the main service: balance hits 0.
    const r = await ctx.api.del(`/api/jobs/${job.id}/line-items/${small.id}`);
    expect(total).toBeGreaterThan(firstLineTotal);
    expect(r.body.totals.balance_cents).toBe(0);
    expect(r.body.stage).toBe('paid');
    expect(r.body.warranties).toBeDefined();
  });

  it('BUG 2: price changes can push the total below what was already paid', async () => {
    const { job, done } = await completedJob([10000, 5000]);
    await ctx.api.post(`/api/jobs/${job.id}/payments`, { amount_cents: 12000, kind: 'deposit', method: 'cash' });
    const big = done.line_items.find((l: any) => l.unit_price_cents === 10000);
    const r = await ctx.api.del(`/api/jobs/${job.id}/line-items/${big.id}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('below_paid');
    const disc = await ctx.api.patch(`/api/jobs/${job.id}`, { discount_cents: 14000 });
    expect(disc.status).toBe(400);
    expect(disc.body.error.code).toBe('below_paid');
  });

  it('BUG 3: very large line items overflow and crash with a 500', async () => {
    const lead = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone() } })).body;
    const r = await ctx.api.post(`/api/jobs/${lead.job.id}/line-items`, { service: 'flat_glass', qty: 1000, unit_price_cents: 9_000_000 });
    expect(r.status).toBeLessThan(500);
  });

  it('BUG 4: losing a job leaves its future appointment on the schedule', async () => {
    const a = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone() }, vehicle: { make: 'Kia' } })).body;
    const b = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone() }, vehicle: { make: 'Kia' } })).body;
    const s = nextSlot(6);
    expect((await ctx.api.post(`/api/jobs/${a.job.id}/appointments`, s)).status).toBe(201);
    await move(a.job.id, 'lost', { lost_reason: 'no_response' });
    const job = (await ctx.api.get(`/api/jobs/${a.job.id}`)).body;
    expect(job.appointments.every((x: any) => x.status === 'cancelled')).toBe(true);
    expect((await ctx.api.post(`/api/jobs/${b.job.id}/appointments`, s)).status).toBe(201);
  });

  it('BUG 5: there is no way to cancel or reschedule an appointment', async () => {
    const a = (await ctx.api.post('/api/leads', { contact: { mobile: nextPhone() }, vehicle: { make: 'Kia' } })).body;
    const s = nextSlot(7);
    const appt = (await ctx.api.post(`/api/jobs/${a.job.id}/appointments`, s)).body;
    const c = await ctx.api.post(`/api/appointments/${appt.id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelled');
    expect((await ctx.api.post(`/api/jobs/${a.job.id}/appointments`, s)).status).toBe(201);
  });
});
