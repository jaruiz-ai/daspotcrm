import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import type { Queryable } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { jobTotals } from '../lib/money.js';
import { canMove, needsFrontSideWaiver, STAGES, type Stage } from '../lib/stages.js';
import { issueWarranties } from '../lib/warranty.js';
import { recordRevShare } from '../lib/revshare.js';
import { sendPaidReceipt } from '../lib/receipt.js';
import { bookAppointment, slotInput, unbookIfNoAppointments } from '../lib/booking.js';
import { assert, idParam, logActivity, optText } from './shared.js';

const SERVICES = ['full_tint', 'front_two', 'windshield', 'sun_strip', 'pano_roof', 'removal', 'wrap',
  'chrome_delete', 'lights', 'flat_glass', 'other'] as const;
const WINDOWS = ['front_left', 'front_right', 'front_sides', 'rear_left', 'rear_right', 'rear_sides', 'back_glass',
  'quarter_left', 'quarter_right', 'windshield', 'sun_strip', 'roof', 'other'] as const;

const lineItemInput = z.object({
  service: z.enum(SERVICES),
  windows: z.array(z.enum(WINDOWS)).max(20).default([]),
  shade_vlt: z.union([z.literal(5), z.literal(15), z.literal(20), z.literal(35), z.literal(40), z.literal(50),
    z.literal(70), z.literal(80)]).nullish(),
  film_product_id: z.uuid().nullish(),
  qty: z.number().int().min(1).max(1000).default(1),
  unit_price_cents: z.number().int().min(0).max(10_000_000),
  description: optText,
}).refine((l) => l.qty * l.unit_price_cents <= 10_000_000, {
  message: 'A single line cannot exceed $100,000', path: ['unit_price_cents'],
});

const OPEN_FOR_EDIT: Stage[] = ['new_lead', 'quoted', 'booked', 'in_bay', 'completed'];

/** Locks the job row for the rest of the transaction so concurrent payments or moves can't race. */
export async function lockJob(q: Queryable, id: string) {
  const { rows } = await q.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Job');
  return rows[0];
}

async function jobDetail(q: Queryable, id: string) {
  const { rows } = await q.query(
    `SELECT j.*, c.first_name, c.last_name, c.mobile, c.language,
            v.year AS vehicle_year, v.make AS vehicle_make, v.model AS vehicle_model, v.plate AS vehicle_plate,
            p.address AS property_address
       FROM jobs j JOIN contacts c ON c.id = j.contact_id
       LEFT JOIN vehicles v ON v.id = j.vehicle_id
       LEFT JOIN properties p ON p.id = j.property_id
      WHERE j.id = $1`, [id]);
  if (!rows[0]) throw notFound('Job');
  const [lines, appts, pays, warranties] = await Promise.all([
    q.query(`SELECT li.*, f.brand AS film_brand, f.line AS film_line, f.tier AS film_tier
               FROM job_line_items li LEFT JOIN film_products f ON f.id = li.film_product_id
              WHERE job_id = $1 ORDER BY li.id`, [id]),
    q.query('SELECT * FROM appointments WHERE job_id = $1 ORDER BY starts_at', [id]),
    q.query('SELECT * FROM payments WHERE job_id = $1 ORDER BY paid_at', [id]),
    q.query(`SELECT *, (status <> 'voided' AND (expires_on IS NULL OR expires_on >= (now() AT TIME ZONE 'America/Chicago')::date)) AS in_term
               FROM warranties WHERE job_id = $1 ORDER BY number`, [id]),
  ]);
  const totals = await jobTotals(q, id);
  return {
    ...rows[0],
    line_items: lines.rows,
    appointments: appts.rows,
    payments: pays.rows,
    warranties: warranties.rows,
    totals,
    waiver_required: needsFrontSideWaiver(lines.rows),
  };
}

/** Completed + nothing owed → Paid, then issue warranties. Called after payments and after completion. */
async function settleIfPaid(q: Queryable, jobId: string) {
  const job = (await q.query('SELECT stage FROM jobs WHERE id = $1', [jobId])).rows[0];
  if (job?.stage !== 'completed') return;
  const t = await jobTotals(q, jobId);
  if (t.total_cents > 0 && t.balance_cents > 0) return;
  // A $0 job only settles if it is a warranty re-do; otherwise someone forgot to price it.
  if (t.total_cents === 0) {
    const redo = (await q.query('SELECT is_warranty_redo FROM jobs WHERE id = $1', [jobId])).rows[0];
    if (!redo?.is_warranty_redo) return;
  }
  await q.query(`UPDATE jobs SET stage = 'paid', updated_at = now() WHERE id = $1`, [jobId]);
  await logActivity(q, 'job', jobId, 'stage_changed', { from: 'completed', to: 'paid', auto: true });
  await issueWarranties(q, jobId);
}

/**
 * After any price change: refuse totals below what the customer already paid
 * (refund first), then settle a completed job whose balance is now cleared.
 */
async function afterPriceChange(q: Queryable, jobId: string) {
  const t = await jobTotals(q, jobId);
  if (t.total_cents < t.paid_cents) {
    throw badRequest('below_paid',
      `That would drop the total to $${(t.total_cents / 100).toFixed(2)}, below the $${(t.paid_cents / 100).toFixed(2)} already paid. Record a refund first.`);
  }
  await settleIfPaid(q, jobId);
}

export function jobsRouter({ db, sender }: Deps) {
  /** After a change commits: if it just made the job Paid, text the customer their receipt. */
  const receiptIfNewlyPaid = async (before: string, after: { id: string; stage: string }) => {
    if (before !== 'paid' && after.stage === 'paid') await sendPaidReceipt({ db, sender }, after.id);
  };
  const r = Router();

  r.get('/pipeline', async (_req, res) => {
    const { rows } = await db.query(
      `SELECT j.id, j.number, j.stage, j.lead_source, j.updated_at, j.created_at,
              c.first_name, c.last_name, c.mobile, c.language,
              v.year, v.make, v.model,
              COALESCE((SELECT SUM(qty::bigint * unit_price_cents) FROM job_line_items WHERE job_id = j.id), 0)::int AS subtotal_cents,
              (SELECT MIN(starts_at) FROM appointments a WHERE a.job_id = j.id AND a.starts_at > now()
                 AND a.status NOT IN ('cancelled','no_show')) AS next_appointment
         FROM jobs j JOIN contacts c ON c.id = j.contact_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE j.stage NOT IN ('lost','paid') OR j.updated_at > now() - interval '30 days'
        ORDER BY j.updated_at DESC`);
    const board = Object.fromEntries(STAGES.map((s) => [s, [] as any[]]));
    for (const row of rows) {
      row.stale = row.stage === 'quoted' && Date.now() - new Date(row.updated_at).getTime() > 3 * 864e5;
      board[row.stage].push(row);
    }
    res.json(board);
  });

  r.get('/jobs/:id', async (req, res) => {
    res.json(await jobDetail(db, idParam(req.params.id, 'Job')));
  });

  r.post('/jobs', async (req, res) => {
    const b = z.object({
      contact_id: z.uuid(),
      vehicle_id: z.uuid().nullish(),
      property_id: z.uuid().nullish(),
      lead_source: optText,
      campaign: optText,
    }).parse(req.body);
    assert(!(b.vehicle_id && b.property_id), 'subject_conflict', 'A job is for a vehicle or a property, not both');
    await assertOwnedSubject(db, b.contact_id, b.vehicle_id, b.property_id);
    const { rows } = await db.query(
      `INSERT INTO jobs (contact_id, vehicle_id, property_id, lead_source, campaign) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.contact_id, b.vehicle_id ?? null, b.property_id ?? null, b.lead_source ?? null, b.campaign ?? null],
    );
    await logActivity(db, 'job', rows[0].id, 'created');
    res.status(201).json(rows[0]);
  });

  r.patch('/jobs/:id', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const b = z.object({
      vehicle_id: z.uuid().nullish(),
      property_id: z.uuid().nullish(),
      discount_cents: z.number().int().min(0).max(10_000_000).optional(),
      tax_rate_bp: z.number().int().min(0).max(10000).optional(),
      assigned_to: z.uuid().nullish(),
      lead_source: optText,
      campaign: optText,
    }).strict().parse(req.body);
    let before = '';
    const out = await db.tx(async (q) => {
      const job = await lockJob(q, id);
      before = job.stage;
      assert(OPEN_FOR_EDIT.includes(job.stage), 'job_locked', 'Paid or lost jobs cannot be edited');
      const next = { ...job, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      assert(!(next.vehicle_id && next.property_id), 'subject_conflict', 'A job is for a vehicle or a property, not both');
      await assertOwnedSubject(q, job.contact_id, b.vehicle_id, b.property_id);
      if (b.discount_cents !== undefined) {
        const t = await jobTotals(q, id);
        assert(b.discount_cents <= t.subtotal_cents, 'discount_too_large', 'Discount cannot exceed the subtotal');
      }
      const fields = Object.entries(b).filter(([, v]) => v !== undefined);
      if (fields.length) {
        const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await q.query(`UPDATE jobs SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...fields.map(([, v]) => v)]);
      }
      if (b.discount_cents !== undefined || b.tax_rate_bp !== undefined) await afterPriceChange(q, id);
      return jobDetail(q, id);
    });
    await receiptIfNewlyPaid(before, out);
    res.json(out);
  });

  r.post('/jobs/:id/line-items', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const li = lineItemInput.parse(req.body);
    const out = await db.tx(async (q) => {
      const job = await lockJob(q, id);
      assert(OPEN_FOR_EDIT.includes(job.stage), 'job_locked', 'Paid or lost jobs cannot be edited');
      if (li.film_product_id) {
        const f = (await q.query('SELECT active FROM film_products WHERE id = $1', [li.film_product_id])).rows[0];
        assert(f, 'unknown_film', 'Film product not found');
        assert(f.active, 'inactive_film', 'That film product is no longer offered');
      }
      await q.query(
        `INSERT INTO job_line_items (job_id, service, windows, shade_vlt, film_product_id, qty, unit_price_cents, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, li.service, li.windows, li.shade_vlt ?? null, li.film_product_id ?? null, li.qty, li.unit_price_cents, li.description ?? null],
      );
      await q.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [id]);
      await afterPriceChange(q, id);
      return jobDetail(q, id);
    });
    res.status(201).json(out);
  });

  r.delete('/jobs/:id/line-items/:lineId', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const lineId = idParam(req.params.lineId, 'Line item');
    let before = '';
    const out = await db.tx(async (q) => {
      const job = await lockJob(q, id);
      before = job.stage;
      assert(OPEN_FOR_EDIT.includes(job.stage), 'job_locked', 'Paid or lost jobs cannot be edited');
      const del = await q.query('DELETE FROM job_line_items WHERE id = $1 AND job_id = $2 RETURNING id', [lineId, id]);
      if (!del.rows[0]) throw notFound('Line item');
      const t = await jobTotals(q, id);
      if (job.discount_cents > t.subtotal_cents) {
        await q.query('UPDATE jobs SET discount_cents = $2 WHERE id = $1', [id, t.subtotal_cents]);
      }
      await q.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [id]);
      await afterPriceChange(q, id);
      return jobDetail(q, id);
    });
    await receiptIfNewlyPaid(before, out);
    res.json(out);
  });

  r.post('/jobs/:id/stage', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const b = z.object({
      to: z.enum(STAGES),
      lost_reason: z.enum(['price', 'went_elsewhere', 'no_response', 'illegal_shade', 'other']).optional(),
    }).parse(req.body);
    let before = '';
    const out = await db.tx(async (q) => {
      const job = await lockJob(q, id);
      before = job.stage;
      const from = job.stage as Stage;
      if (from === b.to) return jobDetail(q, id);
      if (!canMove(from, b.to)) {
        throw conflict('invalid_transition', b.to === 'paid'
          ? 'Jobs move to Paid automatically when the balance is cleared'
          : `Cannot move a job from ${from} to ${b.to}`);
      }
      const lines = (await q.query('SELECT service, windows, shade_vlt FROM job_line_items WHERE job_id = $1', [id])).rows;
      if (b.to === 'lost') assert(b.lost_reason, 'lost_reason_required', 'Pick a reason the job was lost');
      if (b.to === 'quoted') assert(lines.length > 0, 'no_line_items', 'Add at least one service before quoting');
      if (['booked', 'in_bay', 'completed'].includes(b.to)) {
        assert(job.vehicle_id || job.property_id, 'no_subject', 'Attach a vehicle or property first');
        assert(lines.length > 0, 'no_line_items', 'Add at least one service first');
      }
      if (b.to === 'completed') {
        assert(!needsFrontSideWaiver(lines) || job.waiver_signed_at, 'waiver_required',
          'Front side windows darker than 25% need a signed customer acknowledgment before completion');
        const t = await jobTotals(q, id);
        assert(t.total_cents > 0 || job.is_warranty_redo, 'unpriced_job', 'This job has a $0 total; price it before completing');
      }
      await q.query(
        `UPDATE jobs SET stage = $2,
                lost_reason = CASE WHEN $2 = 'lost' THEN $3 ELSE NULL END,
                completed_at = CASE WHEN $2 = 'completed' THEN now() WHEN $2 = 'in_bay' THEN NULL ELSE completed_at END,
                updated_at = now()
          WHERE id = $1`,
        [id, b.to, b.lost_reason ?? null],
      );
      if (b.to === 'lost') {
        await q.query(
          `UPDATE appointments SET status = 'cancelled'
            WHERE job_id = $1 AND status IN ('scheduled','confirmed') AND starts_at > now()`, [id]);
      }
      await logActivity(q, 'job', id, 'stage_changed', { from, to: b.to, lost_reason: b.lost_reason });
      if (b.to === 'completed') await settleIfPaid(q, id);
      return jobDetail(q, id);
    });
    await receiptIfNewlyPaid(before, out);
    res.json(out);
  });

  r.post('/jobs/:id/waiver', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const b = z.object({ signed_name: z.string().trim().min(2).max(120) }).parse(req.body);
    const out = await db.tx(async (q) => {
      const job = await lockJob(q, id);
      assert(OPEN_FOR_EDIT.includes(job.stage), 'job_locked', 'Paid or lost jobs cannot be edited');
      await q.query('UPDATE jobs SET waiver_signed_at = now(), waiver_name = $2, updated_at = now() WHERE id = $1', [id, b.signed_name]);
      await logActivity(q, 'job', id, 'waiver_signed', { name: b.signed_name });
      return jobDetail(q, id);
    });
    res.json(out);
  });

  r.post('/jobs/:id/appointments', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const b = slotInput.parse(req.body);
    const out = await db.tx(async (q) => bookAppointment(q, await lockJob(q, id), b));
    res.status(201).json(out);
  });

  r.post('/appointments/:id/cancel', async (req, res) => {
    const id = idParam(req.params.id, 'Appointment');
    const b = z.object({ reason: z.enum(['client_cancelled', 'shop_cancelled', 'no_show']).default('client_cancelled') }).parse(req.body ?? {});
    const out = await db.tx(async (q) => {
      const appt = (await q.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!appt) throw notFound('Appointment');
      if (!['scheduled', 'confirmed'].includes(appt.status)) throw conflict('not_cancellable', `Appointment is already ${appt.status.replace('_', ' ')}`);
      const status = b.reason === 'no_show' ? 'no_show' : 'cancelled';
      const row = (await q.query('UPDATE appointments SET status = $2 WHERE id = $1 RETURNING *', [id, status])).rows[0];
      await logActivity(q, 'job', appt.job_id, b.reason === 'no_show' ? 'appointment_no_show' : 'appointment_cancelled',
        { appointment_id: id, reason: b.reason, starts_at: appt.starts_at });
      await unbookIfNoAppointments(q, appt.job_id);
      return row;
    });
    res.json(out);
  });

  r.post('/appointments/:id/reschedule', async (req, res) => {
    const id = idParam(req.params.id, 'Appointment');
    const b = slotInput.parse(req.body);
    assert(new Date(b.ends_at) > new Date(b.starts_at), 'bad_time_range', 'End time must be after start time');
    const out = await db.tx(async (q) => {
      const appt = (await q.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!appt) throw notFound('Appointment');
      if (!['scheduled', 'confirmed'].includes(appt.status)) throw conflict('not_reschedulable', `Appointment is already ${appt.status.replace('_', ' ')}`);
      const job = await lockJob(q, appt.job_id);
      assert(['new_lead', 'quoted', 'booked'].includes(job.stage), 'job_not_bookable',
        'This job is already in the bay or finished, so its appointment can no longer move');
      const row = (await q.query(
        `UPDATE appointments SET starts_at = $2, ends_at = $3, status = 'scheduled' WHERE id = $1 RETURNING *`,
        [id, b.starts_at, b.ends_at])).rows[0];
      await logActivity(q, 'job', appt.job_id, 'appointment_rescheduled', {
        appointment_id: id, from: { starts_at: appt.starts_at, ends_at: appt.ends_at }, to: { starts_at: b.starts_at, ends_at: b.ends_at } });
      return row;
    });
    res.json(out);
  });

  r.post('/jobs/:id/payments', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const b = z.object({
      amount_cents: z.number().int().min(1).max(10_000_000),
      kind: z.enum(['deposit', 'balance', 'refund']),
      method: z.enum(['card', 'cash', 'zelle', 'affirm', 'afterpay', 'terms']),
      processor_fee_cents: z.number().int().min(0).default(0),
      external_ref: optText,
      // When the money actually moved, if not now (e.g. entering an older payment). Defaults to now.
      paid_at: z.iso.datetime({ offset: true }).optional(),
    }).refine((p) => p.processor_fee_cents <= p.amount_cents, {
      message: 'Processor fee cannot be more than the payment', path: ['processor_fee_cents'],
    }).parse(req.body);
    let before = '';
    const out = await db.tx(async (q) => {
      const job = await lockJob(q, id);
      before = job.stage;
      assert(job.stage !== 'lost' || b.kind === 'refund', 'job_lost', 'Cannot take payment on a lost job');
      const t = await jobTotals(q, id);
      if (b.kind === 'refund') {
        assert(b.amount_cents <= t.paid_cents, 'refund_too_large', 'Refund exceeds what has been paid');
      } else {
        assert(t.total_cents > 0, 'unpriced_job', 'Add services before taking payment');
        if (b.amount_cents > t.balance_cents) {
          throw badRequest('overpayment', `Payment exceeds the balance of $${(t.balance_cents / 100).toFixed(2)}`);
        }
      }
      if (b.external_ref) {
        const dup = await q.query('SELECT id FROM payments WHERE external_ref = $1', [b.external_ref]);
        if (dup.rows[0]) throw conflict('duplicate_payment', 'This payment was already recorded');
      }
      if (b.paid_at) {
        const at = Date.parse(b.paid_at);
        assert(at <= Date.now() + 5 * 60_000, 'future_payment', 'Payment date cannot be in the future');
        assert(at >= Date.now() - 400 * 864e5, 'old_payment', 'Payment date is more than a year ago');
      }
      const pay = (await q.query(
        `INSERT INTO payments (job_id, amount_cents, kind, method, processor_fee_cents, external_ref, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now())) RETURNING *`,
        [id, b.amount_cents, b.kind, b.method, b.processor_fee_cents, b.external_ref ?? null, b.paid_at ?? null],
      )).rows[0];
      await logActivity(q, 'job', id, 'payment', { amount_cents: b.amount_cents, kind: b.kind, method: b.method });
      await recordRevShare(q, pay.id);
      await settleIfPaid(q, id);
      return jobDetail(q, id);
    });
    await receiptIfNewlyPaid(before, out);
    res.status(201).json(out);
  });

  r.get('/jobs/:id/activity', async (req, res) => {
    const id = idParam(req.params.id, 'Job');
    const { rows } = await db.query(
      `SELECT * FROM activity WHERE subject_type = 'job' AND subject_id = $1 ORDER BY occurred_at DESC`, [id]);
    res.json(rows);
  });

  return r;
}

/** Vehicles and properties on a job must belong to that job's customer. */
export async function assertOwnedSubject(q: Queryable, contactId: string, vehicleId?: string | null, propertyId?: string | null) {
  if (vehicleId) {
    const v = await q.query('SELECT contact_id FROM vehicles WHERE id = $1', [vehicleId]);
    assert(v.rows[0], 'unknown_vehicle', 'Vehicle not found');
    assert(v.rows[0].contact_id === contactId, 'wrong_owner', 'That vehicle belongs to a different customer');
  }
  if (propertyId) {
    const p = await q.query('SELECT contact_id FROM properties WHERE id = $1', [propertyId]);
    assert(p.rows[0], 'unknown_property', 'Property not found');
    assert(p.rows[0].contact_id === contactId, 'wrong_owner', 'That property belongs to a different customer');
  }
}
