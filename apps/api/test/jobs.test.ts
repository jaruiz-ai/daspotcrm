import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { nextPhone, setup } from './helpers.js';
import { issueWarranties } from '../src/lib/warranty.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });

async function newLead(source = 'instagram', vehicle: object | null = { year: 2022, make: 'Toyota', model: 'Camry', plate: 'abc 1234' }) {
  const res = await ctx.api.post('/api/leads', {
    contact: { first_name: 'Test', mobile: nextPhone() },
    ...(vehicle ? { vehicle } : {}),
    lead_source: source,
  });
  expect(res.status).toBe(201);
  return res.body as { contact: any; vehicle: any; job: any };
}

const addLine = (jobId: string, body: object) => ctx.api.post(`/api/jobs/${jobId}/line-items`, body);
const move = (jobId: string, to: string, extra: object = {}) => ctx.api.post(`/api/jobs/${jobId}/stage`, { to, ...extra });
const pay = (jobId: string, amount_cents: number, kind = 'balance', method = 'card', extra: object = {}) =>
  ctx.api.post(`/api/jobs/${jobId}/payments`, { amount_cents, kind, method, ...extra });

let slot = 0;
/** Unique, non-overlapping appointment windows so tests don't collide on bays. */
function nextSlot(bay = 1) {
  const start = new Date(Date.UTC(2027, 0, 1, 14) + slot++ * 3 * 3600_000);
  return { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 2 * 3600_000).toISOString(), bay };
}

describe('auth and input safety', () => {
  it('rejects API calls without the staff token', async () => {
    expect((await request(ctx.app).get('/api/pipeline')).status).toBe(401);
    expect((await request(ctx.app).get('/api/pipeline').set('authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('returns 404, not 500, for malformed ids', async () => {
    expect((await ctx.api.get('/api/jobs/not-a-uuid')).status).toBe(404);
    expect((await ctx.api.get('/api/jobs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('returns 400 for bad JSON and invalid phones', async () => {
    const bad = await request(ctx.app).post('/api/leads').set('authorization', 'Bearer test-token')
      .set('content-type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
    const phone = await ctx.api.post('/api/leads', { contact: { mobile: '555' } });
    expect(phone.status).toBe(400);
  });

  it('treats search text as text, not SQL wildcards', async () => {
    const res = await ctx.api.get('/api/contacts?q=%25');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('quick lead', () => {
  it('creates contact, vehicle and job together, and reuses the contact for a repeat number', async () => {
    const mobile = nextPhone();
    const a = await ctx.api.post('/api/leads', { contact: { mobile }, vehicle: { year: 2020, make: 'Ford', model: 'F-150' } });
    const b = await ctx.api.post('/api/leads', { contact: { mobile: mobile.replace('+1', '') } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.reused_contact).toBe(true);
    expect(b.body.contact.id).toBe(a.body.contact.id);
    expect(a.body.job.stage).toBe('new_lead');
    expect(a.body.vehicle.contact_id).toBe(a.body.contact.id);
  });

  it('rolls back everything if any part fails', async () => {
    const mobile = nextPhone();
    const res = await ctx.api.post('/api/leads', { contact: { mobile }, vehicle: { vin: 'BAD' } });
    expect(res.status).toBe(400);
    const found = await ctx.api.get(`/api/contacts?q=${mobile.slice(-7)}`);
    expect(found.body).toEqual([]);
  });

  it('blocks a second contact with the same number', async () => {
    const mobile = nextPhone();
    expect((await ctx.api.post('/api/contacts', { mobile })).status).toBe(201);
    const dup = await ctx.api.post('/api/contacts', { mobile });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_mobile');
  });
});

describe('job lifecycle', () => {
  it('runs lead → quote → book → bay → complete → paid and issues warranties', async () => {
    const { job } = await newLead();
    expect((await move(job.id, 'quoted')).body.error.code).toBe('no_line_items');

    let r = await addLine(job.id, { service: 'full_tint', shade_vlt: 35, film_product_id: ctx.film('Nano Ceramic'), unit_price_cents: 40000 });
    expect(r.status).toBe(201);
    expect(r.body.totals).toMatchObject({ subtotal_cents: 40000, tax_cents: 3300, total_cents: 43300 });

    expect((await move(job.id, 'quoted')).body.stage).toBe('quoted');
    const appt = await ctx.api.post(`/api/jobs/${job.id}/appointments`, nextSlot());
    expect(appt.status).toBe(201);
    expect((await ctx.api.get(`/api/jobs/${job.id}`)).body.stage).toBe('booked');

    expect((await pay(job.id, 5000, 'deposit')).status).toBe(201);
    expect((await move(job.id, 'in_bay')).body.stage).toBe('in_bay');
    r = await move(job.id, 'completed');
    expect(r.body.stage).toBe('completed');
    expect(r.body.totals.balance_cents).toBe(38300);
    expect(r.body.warranties).toHaveLength(0);

    r = await pay(job.id, 38300);
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe('paid');
    expect(r.body.totals.balance_cents).toBe(0);
    const mfr = r.body.warranties.find((w: any) => w.coverage === 'manufacturer');
    const labor = r.body.warranties.find((w: any) => w.coverage === 'labor');
    expect(mfr).toMatchObject({ film_line: 'Nano Ceramic', expires_on: null, number: `DS-${job.number}-M1` });
    expect(labor.expires_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 24-month labor warranty.
    expect(Number(labor.expires_on.slice(0, 4)) - Number(labor.starts_on.slice(0, 4))).toBe(2);
  });

  it('settles straight to Paid when the customer prepaid in full', async () => {
    const { job } = await newLead();
    await addLine(job.id, { service: 'front_two', shade_vlt: 35, film_product_id: ctx.film('Carbon'), unit_price_cents: 10000 });
    await move(job.id, 'quoted');
    await ctx.api.post(`/api/jobs/${job.id}/appointments`, nextSlot());
    expect((await pay(job.id, 10825)).status).toBe(201);
    await move(job.id, 'in_bay');
    const r = await move(job.id, 'completed');
    expect(r.body.stage).toBe('paid');
    expect(r.body.warranties.length).toBeGreaterThan(0);
  });

  it('requires a signed waiver for front sides darker than 25%', async () => {
    const { job } = await newLead();
    await addLine(job.id, { service: 'full_tint', shade_vlt: 20, film_product_id: ctx.film('Carbon'), unit_price_cents: 20000 });
    await move(job.id, 'quoted');
    await ctx.api.post(`/api/jobs/${job.id}/appointments`, nextSlot());
    await move(job.id, 'in_bay');
    const blocked = await move(job.id, 'completed');
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('waiver_required');
    expect((await ctx.api.post(`/api/jobs/${job.id}/waiver`, { signed_name: 'Test Customer' })).status).toBe(200);
    expect((await move(job.id, 'completed')).body.stage).toBe('completed');
  });

  it('blocks illegal moves and needs a reason to lose a job', async () => {
    const { job } = await newLead();
    expect((await move(job.id, 'completed')).body.error.code).toBe('invalid_transition');
    expect((await move(job.id, 'paid')).body.error.message).toMatch(/automatically/);
    expect((await move(job.id, 'lost')).body.error.code).toBe('lost_reason_required');
    const lost = await move(job.id, 'lost', { lost_reason: 'price' });
    expect(lost.body).toMatchObject({ stage: 'lost', lost_reason: 'price' });
    const reopened = await move(job.id, 'new_lead');
    expect(reopened.body).toMatchObject({ stage: 'new_lead', lost_reason: null });
  });

  it('will not complete a $0 job or one with no vehicle', async () => {
    const { job } = await newLead('walk-in', null);
    await addLine(job.id, { service: 'other', unit_price_cents: 0 });
    await move(job.id, 'quoted');
    expect((await move(job.id, 'booked')).body.error.code).toBe('no_subject');
  });
});

describe('money rules', () => {
  it('rejects overpayment, oversize refunds, and payments on lost jobs', async () => {
    const { job } = await newLead();
    expect((await pay(job.id, 100)).body.error.code).toBe('unpriced_job');
    await addLine(job.id, { service: 'windshield', shade_vlt: 70, unit_price_cents: 10000 });
    expect((await pay(job.id, 999999)).body.error.code).toBe('overpayment');
    expect((await pay(job.id, 5000)).status).toBe(201);
    expect((await pay(job.id, 6000, 'refund')).body.error.code).toBe('refund_too_large');
    const refund = await pay(job.id, 5000, 'refund');
    expect(refund.body.totals.paid_cents).toBe(0);
    await move(job.id, 'lost', { lost_reason: 'went_elsewhere' });
    expect((await pay(job.id, 100)).body.error.code).toBe('job_lost');
  });

  it('records a processor reference only once', async () => {
    const { job } = await newLead();
    await addLine(job.id, { service: 'sun_strip', unit_price_cents: 5000 });
    expect((await pay(job.id, 1000, 'deposit', 'card', { external_ref: 'pi_123' })).status).toBe(201);
    expect((await pay(job.id, 1000, 'deposit', 'card', { external_ref: 'pi_123' })).body.error.code).toBe('duplicate_payment');
  });

  it('caps discounts at the subtotal, including after a line is removed', async () => {
    const { job } = await newLead();
    const a = await addLine(job.id, { service: 'full_tint', unit_price_cents: 30000 });
    await addLine(job.id, { service: 'sun_strip', unit_price_cents: 5000 });
    expect((await ctx.api.patch(`/api/jobs/${job.id}`, { discount_cents: 50000 })).body.error.code).toBe('discount_too_large');
    expect((await ctx.api.patch(`/api/jobs/${job.id}`, { discount_cents: 20000 })).status).toBe(200);
    const big = a.body.line_items.find((l: any) => l.service === 'full_tint');
    const r = await ctx.api.del(`/api/jobs/${job.id}/line-items/${big.id}`);
    expect(r.body.discount_cents).toBe(5000);
    expect(r.body.totals.total_cents).toBe(0);
  });

  it('locks pricing once a job is paid', async () => {
    const { job } = await newLead();
    await addLine(job.id, { service: 'lights', unit_price_cents: 8000 });
    await move(job.id, 'quoted');
    await ctx.api.post(`/api/jobs/${job.id}/appointments`, nextSlot());
    await move(job.id, 'in_bay');
    await move(job.id, 'completed');
    await pay(job.id, 8660);
    expect((await addLine(job.id, { service: 'lights', unit_price_cents: 1 })).body.error.code).toBe('job_locked');
  });
});

describe('scheduling', () => {
  it('lets the shop book several cars at the same time (no bays)', async () => {
    const a = (await newLead()).job;
    const b = (await newLead()).job;
    const s = nextSlot();
    expect((await ctx.api.post(`/api/jobs/${a.id}/appointments`, s)).status).toBe(201);
    const overlap = await ctx.api.post(`/api/jobs/${b.id}/appointments`, {
      starts_at: new Date(new Date(s.starts_at).getTime() + 3600_000).toISOString(),
      ends_at: new Date(new Date(s.ends_at).getTime() + 3600_000).toISOString() });
    expect(overlap.status).toBe(201);
  });

  it('rejects end before start', async () => {
    const { job } = await newLead();
    const s = nextSlot();
    expect((await ctx.api.post(`/api/jobs/${job.id}/appointments`, { ...s, ends_at: s.starts_at })).status).toBe(400);
  });
});

describe('vehicles belong to the right customer', () => {
  it('will not attach another customer\'s car to a job', async () => {
    const a = await newLead();
    const b = await newLead();
    const r = await ctx.api.patch(`/api/jobs/${a.job.id}`, { vehicle_id: b.vehicle.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('wrong_owner');
  });
});

describe('rev-share', () => {
  it('pays the partner 20% of pre-tax collected revenue on attributed jobs, net of refunds', async () => {
    const partner = (await ctx.api.post('/api/partners', { name: 'Sublink' })).body;
    expect((await ctx.api.post(`/api/partners/${partner.id}/rules`, { percent: 20, sources: ['funnel'], starts_on: '2026-01-01' })).status).toBe(201);

    const { job } = await newLead('funnel');
    await addLine(job.id, { service: 'full_tint', unit_price_cents: 40000 }); // total 433.00 with tax
    await pay(job.id, 43300);
    await pay(job.id, 10825, 'refund'); // refund 100.00 + tax

    const other = await newLead('walk-in');
    await addLine(other.job.id, { service: 'full_tint', unit_price_cents: 40000 });
    await pay(other.job.id, 43300);

    const payouts = (await ctx.api.get(`/api/partners/${partner.id}/payouts`)).body;
    expect(payouts).toHaveLength(1);
    // 400.00 - 100.00 pre-tax = 300.00 → 20% = 60.00
    expect(payouts[0]).toMatchObject({ jobs: 1, basis_cents: 30000, share_cents: 6000 });
  });

  it('rejects bad rule dates', async () => {
    const partner = (await ctx.api.post('/api/partners', { name: 'P2' })).body;
    const r = await ctx.api.post(`/api/partners/${partner.id}/rules`, { percent: 10, starts_on: '2026-05-01', ends_on: '2026-04-01' });
    expect(r.status).toBe(400);
  });
});

describe('warranties and claims', () => {
  async function paidJob() {
    const lead = await newLead();
    const { job } = lead;
    await addLine(job.id, { service: 'full_tint', shade_vlt: 35, film_product_id: ctx.film('Carbon'), unit_price_cents: 20000 });
    await move(job.id, 'quoted');
    await ctx.api.post(`/api/jobs/${job.id}/appointments`, nextSlot());
    await move(job.id, 'in_bay');
    await move(job.id, 'completed');
    const r = await pay(job.id, 21650);
    expect(r.body.stage).toBe('paid');
    return { ...lead, job: r.body };
  }

  it('finds warranties by phone, plate, VIN-less number and warranty number', async () => {
    const { contact, job } = await paidJob();
    const byPhone = await ctx.api.get(`/api/warranties/lookup?q=${encodeURIComponent(contact.mobile.slice(2))}`);
    expect(byPhone.body.length).toBeGreaterThan(0);
    const byPlate = await ctx.api.get('/api/warranties/lookup?q=abc1234');
    expect(byPlate.body.some((w: any) => w.job_id === job.id)).toBe(true);
    const byNumber = await ctx.api.get(`/api/warranties/lookup?q=ds-${job.number}-m1`);
    expect(byNumber.body).toHaveLength(1);
    expect(byNumber.body[0]).toMatchObject({ in_term: true, film_line: 'Carbon' });
  });

  it('a covered claim opens a no-charge re-do that settles without a second warranty', async () => {
    const { job } = await paidJob();
    const w = job.warranties.find((x: any) => x.coverage === 'manufacturer');
    const claim = await ctx.api.post(`/api/warranties/${w.id}/claims`, { issue: 'bubbling' });
    expect(claim.status).toBe(201);
    const d = await ctx.api.post(`/api/claims/${claim.body.id}/decision`, { decision: 'covered' });
    expect(d.body.redo_job).toMatchObject({ is_warranty_redo: true, vehicle_id: job.vehicle_id });
    expect((await ctx.api.post(`/api/claims/${claim.body.id}/decision`, { decision: 'covered' })).body.error.code).toBe('already_decided');

    const redo = d.body.redo_job.id;
    await addLine(redo, { service: 'full_tint', shade_vlt: 35, film_product_id: ctx.film('Carbon'), unit_price_cents: 0 });
    await move(redo, 'quoted');
    await ctx.api.post(`/api/jobs/${redo}/appointments`, nextSlot());
    await move(redo, 'in_bay');
    const done = await move(redo, 'completed');
    expect(done.body.stage).toBe('paid');
    expect(done.body.warranties).toHaveLength(0);
  });

  it('refuses claims on voided warranties', async () => {
    const { job } = await paidJob();
    const w = job.warranties[0];
    expect((await ctx.api.post(`/api/warranties/${w.id}/void`, { reason: 'Film removed by another shop' })).status).toBe(200);
    expect((await ctx.api.post(`/api/warranties/${w.id}/claims`, { issue: 'peeling' })).body.error.code).toBe('warranty_voided');
  });

  it('dates warranties by the shop\'s local day, not UTC', async () => {
    const { job } = await newLead();
    await addLine(job.id, { service: 'full_tint', film_product_id: ctx.film('Carbon'), unit_price_cents: 100 });
    // 10:30pm in Dallas on Oct 12 is already Oct 13 in UTC.
    await ctx.db.query(`UPDATE jobs SET completed_at = '2026-10-13T03:30:00Z' WHERE id = $1`, [job.id]);
    await issueWarranties(ctx.db, job.id);
    const { rows } = await ctx.db.query(`SELECT starts_on, expires_on FROM warranties WHERE job_id = $1 AND coverage = 'manufacturer'`, [job.id]);
    expect(rows[0]).toEqual({ starts_on: '2026-10-12', expires_on: '2031-10-12' });
    // Running it again must not duplicate.
    expect(await issueWarranties(ctx.db, job.id)).toBe(0);
  });
});
