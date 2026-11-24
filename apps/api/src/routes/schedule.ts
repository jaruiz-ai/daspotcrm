import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { bookAppointment, slotInput } from '../lib/booking.js';
import { jobTotals } from '../lib/money.js';
import { SHOP_TZ } from '../lib/warranty.js';
import { assertOwnedSubject, lockJob } from './jobs.js';
import { idParam, insertVehicle, logActivity, optText, phone, vehicleInput } from './shared.js';

const SERVICE = z.enum(['full_tint', 'front_two', 'windshield', 'sun_strip', 'pano_roof', 'removal', 'wrap',
  'chrome_delete', 'lights', 'flat_glass', 'other']);

/** The shop's calendar day right now, as 'YYYY-MM-DD'. */
export const shopToday = () => new Date().toLocaleDateString('en-CA', { timeZone: SHOP_TZ });

const newAppointmentInput = z.object({
  /** Book an existing open job (a lead or quote) instead of starting a new one. */
  job_id: z.uuid().nullish(),
  contact: z.object({
    mobile: phone,
    first_name: optText,
    last_name: optText,
    language: z.enum(['en', 'es']).default('en'),
  }).optional(),
  vehicle_id: z.uuid().nullish(),
  vehicle: vehicleInput.optional(),
  service: SERVICE.nullish(),
  price_cents: z.number().int().min(0).max(10_000_000).nullish(),
  note: optText,
  lead_source: optText,
  slot: slotInput,
}).refine((b) => b.job_id || b.contact, { message: 'Pick a client or enter their mobile number', path: ['contact'] });

export function scheduleRouter({ db }: Deps) {
  const r = Router();

  /**
   * The home screen: one shop-local day of appointments, what is in the bay now,
   * finished jobs still owed money, and leads waiting for an answer.
   */
  r.get('/today', async (req, res) => {
    const date = z.iso.date().catch(shopToday()).parse(req.query.date ?? shopToday());
    const [appts, inBay, completed, waiting] = await Promise.all([
      db.query(
        `SELECT a.id AS appointment_id, a.starts_at, a.ends_at, a.bay, a.status AS appointment_status,
                j.id, j.number, j.stage, c.first_name, c.last_name, c.mobile, c.language, v.year, v.make, v.model,
                ARRAY(SELECT li.service FROM job_line_items li WHERE li.job_id = j.id ORDER BY li.service) AS services,
                (SELECT n.body FROM notes n WHERE n.subject_type = 'job' AND n.subject_id = j.id
                  ORDER BY n.created_at DESC LIMIT 1) AS note
           FROM appointments a
           JOIN jobs j ON j.id = a.job_id
           JOIN contacts c ON c.id = j.contact_id
           LEFT JOIN vehicles v ON v.id = j.vehicle_id
          WHERE a.status NOT IN ('cancelled','no_show')
            AND a.starts_at < (($1::date + 1)::timestamp AT TIME ZONE '${SHOP_TZ}')
            AND a.ends_at   > (($1::date)::timestamp AT TIME ZONE '${SHOP_TZ}')
          ORDER BY a.starts_at, a.bay`, [date]),
      db.query(
        `SELECT j.id, j.number, j.stage, c.first_name, c.last_name, c.mobile, v.year, v.make, v.model
           FROM jobs j JOIN contacts c ON c.id = j.contact_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
          WHERE j.stage = 'in_bay' ORDER BY j.updated_at`),
      db.query(
        `SELECT j.id, j.number, j.stage, c.first_name, c.last_name, c.mobile, v.year, v.make, v.model
           FROM jobs j JOIN contacts c ON c.id = j.contact_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
          WHERE j.stage = 'completed' ORDER BY j.updated_at`),
      db.query(
        `SELECT count(*) FILTER (WHERE stage = 'new_lead')::int AS new_leads,
                count(*) FILTER (WHERE stage = 'quoted' AND updated_at < now() - interval '3 days')::int AS stale_quotes
           FROM jobs WHERE stage IN ('new_lead','quoted')`),
    ]);
    const toCollect = [];
    for (const j of completed.rows) {
      const t = await jobTotals(db, j.id);
      if (t.balance_cents > 0) toCollect.push({ ...j, balance_cents: t.balance_cents });
    }
    res.json({
      date,
      today: shopToday(),
      appointments: appts.rows,
      in_bay: inBay.rows,
      to_collect: toCollect,
      new_leads: waiting.rows[0].new_leads,
      stale_quotes: waiting.rows[0].stale_quotes,
    });
  });

  /** Seven shop-local days of appointments starting at ?start (today by default), grouped by day. */
  r.get('/week', async (req, res) => {
    const start = z.iso.date().catch(shopToday()).parse(req.query.start ?? shopToday());
    const { rows } = await db.query(
      `SELECT ((a.starts_at AT TIME ZONE '${SHOP_TZ}')::date)::text AS day,
              a.id AS appointment_id, a.starts_at, a.ends_at, a.bay, a.status AS appointment_status,
              j.id, j.number, j.stage, c.first_name, c.last_name, c.mobile, v.year, v.make, v.model,
              ARRAY(SELECT li.service FROM job_line_items li WHERE li.job_id = j.id ORDER BY li.service) AS services
         FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         JOIN contacts c ON c.id = j.contact_id
         LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE a.status NOT IN ('cancelled','no_show')
          AND a.starts_at >= (($1::date)::timestamp AT TIME ZONE '${SHOP_TZ}')
          AND a.starts_at <  (($1::date + 7)::timestamp AT TIME ZONE '${SHOP_TZ}')
        ORDER BY a.starts_at, a.bay`, [start]);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(Date.parse(`${start}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
      return { date, appointments: rows.filter((r) => r.day === date) };
    });
    res.json({ start, today: shopToday(), days });
  });

  /**
   * Add appointment: client (existing or new, matched by mobile) + vehicle + optional service,
   * booked into a bay in one transaction. Lands in Booked on the pipeline.
   */
  r.post('/appointments', async (req, res) => {
    const b = newAppointmentInput.parse(req.body);
    const out = await db.tx(async (q) => {
      let job;
      let created = false;
      if (b.job_id) {
        job = await lockJob(q, idParam(b.job_id, 'Job'));
      } else {
        const c = b.contact!;
        let contact = (await q.query('SELECT * FROM contacts WHERE mobile = $1', [c.mobile])).rows[0];
        if (!contact) {
          contact = (await q.query(
            `INSERT INTO contacts (first_name, last_name, mobile, language, lead_source) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [c.first_name ?? null, c.last_name ?? null, c.mobile, c.language, b.lead_source ?? null],
          )).rows[0];
        } else if ((!contact.first_name && c.first_name) || (!contact.last_name && c.last_name)) {
          // Fill in a name the shop didn't have yet; never overwrite one it does.
          contact = (await q.query(
            `UPDATE contacts SET first_name = COALESCE(first_name, $2), last_name = COALESCE(last_name, $3), updated_at = now()
              WHERE id = $1 RETURNING *`, [contact.id, c.first_name ?? null, c.last_name ?? null])).rows[0];
        }
        let vehicleId: string | null = null;
        if (b.vehicle_id) {
          await assertOwnedSubject(q, contact.id, b.vehicle_id, null);
          vehicleId = b.vehicle_id;
        } else if (b.vehicle && (b.vehicle.make || b.vehicle.model || b.vehicle.year)) {
          const v = b.vehicle;
          const same = (await q.query(
            `SELECT id FROM vehicles WHERE contact_id = $1
                AND lower(coalesce(make,'')) = lower(coalesce($2,'')) AND lower(coalesce(model,'')) = lower(coalesce($3,''))
                AND (year IS NOT DISTINCT FROM $4 OR $4::int IS NULL)
              ORDER BY created_at LIMIT 1`, [contact.id, v.make ?? null, v.model ?? null, v.year ?? null])).rows[0];
          vehicleId = same?.id ?? (await insertVehicle(q, contact.id, v)).id;
        }
        job = (await q.query(
          `INSERT INTO jobs (contact_id, vehicle_id, lead_source) VALUES ($1,$2,$3) RETURNING *`,
          [contact.id, vehicleId, b.lead_source ?? contact.lead_source ?? null],
        )).rows[0];
        created = true;
        await logActivity(q, 'job', job.id, 'created', { via: 'add_appointment' });
      }

      if (b.service && b.price_cents != null) {
        await q.query(`INSERT INTO job_line_items (job_id, service, unit_price_cents) VALUES ($1,$2,$3)`,
          [job.id, b.service, b.price_cents]);
      }
      // A service without a price yet goes in the note, so a $0 line never makes the job look paid.
      const noteParts = [b.service && b.price_cents == null ? `Booked for: ${serviceLabel(b.service)}` : null, b.note].filter(Boolean);
      if (noteParts.length) {
        await q.query(`INSERT INTO notes (subject_type, subject_id, body) VALUES ('job', $1, $2)`, [job.id, noteParts.join('. ')]);
      }
      const appointment = await bookAppointment(q, job, b.slot);
      return { job_id: job.id, job_number: job.number, created_job: created, appointment };
    });
    res.status(201).json(out);
  });

  /** Open jobs (lead, quote, booked) for one client, so a booking can attach to the right one. */
  r.get('/contacts/:id/open-jobs', async (req, res) => {
    const id = idParam(req.params.id, 'Contact');
    const { rows } = await db.query(
      `SELECT j.id, j.number, j.stage, j.vehicle_id, v.year, v.make, v.model,
              COALESCE((SELECT SUM(qty::bigint * unit_price_cents) FROM job_line_items WHERE job_id = j.id), 0)::int AS subtotal_cents
         FROM jobs j LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE j.contact_id = $1 AND j.stage IN ('new_lead','quoted')
        ORDER BY j.updated_at DESC`, [id]);
    res.json(rows);
  });

  return r;
}

const LABELS: Record<string, string> = {
  full_tint: 'Full tint', front_two: 'Front two', windshield: 'Windshield', sun_strip: 'Sun strip',
  pano_roof: 'Panoramic roof', removal: 'Old film removal', wrap: 'Wrap', chrome_delete: 'Chrome delete',
  lights: 'Lights', flat_glass: 'Home / storefront', other: 'Other',
};
const serviceLabel = (s: string) => LABELS[s] ?? s;
