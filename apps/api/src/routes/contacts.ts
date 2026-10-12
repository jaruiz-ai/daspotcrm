import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { conflict } from '../lib/errors.js';
import { idParam, insertVehicle, logActivity, mustExist, optText, phone, vehicleInput } from './shared.js';

const contactInput = z.object({
  first_name: optText,
  last_name: optText,
  mobile: phone,
  email: z.preprocess((v) => (v === '' ? null : v), z.email().nullish()),
  language: z.enum(['en', 'es']).default('en'),
  preferred_channel: z.enum(['sms', 'whatsapp']).default('sms'),
  ig_handle: optText,
  lead_source: optText,
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

const quickLeadInput = z.object({
  contact: contactInput,
  vehicle: vehicleInput.optional(),
  lead_source: optText,
  note: optText,
});

export function contactsRouter({ db }: Deps) {
  const r = Router();

  r.get('/contacts', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const digits = q.replace(/\D/g, '');
    const { rows } = await db.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM jobs j WHERE j.contact_id = c.id) AS job_count
         FROM contacts c
        WHERE $1 = ''
           OR (coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ILIKE '%' || $1 || '%'
           OR c.email ILIKE '%' || $1 || '%'
           OR ($2 <> '' AND length($2) >= 4 AND c.mobile LIKE '%' || $2 || '%')
        ORDER BY c.created_at DESC LIMIT $3`,
      [q.replace(/[%_\\]/g, (m) => '\\' + m), digits, limit],
    );
    res.json(rows);
  });

  r.post('/contacts', async (req, res) => {
    const c = contactInput.parse(req.body);
    const existing = await db.query('SELECT id FROM contacts WHERE mobile = $1', [c.mobile]);
    if (existing.rows[0]) throw conflict('duplicate_mobile', 'A contact with this mobile number already exists', { contact_id: existing.rows[0].id });
    const { rows } = await db.query(
      `INSERT INTO contacts (first_name, last_name, mobile, email, language, preferred_channel, ig_handle, lead_source, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [c.first_name ?? null, c.last_name ?? null, c.mobile, c.email ?? null, c.language, c.preferred_channel,
       c.ig_handle ?? null, c.lead_source ?? null, c.tags],
    );
    res.status(201).json(rows[0]);
  });

  r.get('/contacts/:id', async (req, res) => {
    const id = idParam(req.params.id, 'Contact');
    const contact = await mustExist(db, 'contacts', id, 'Contact');
    const [vehicles, properties, jobs, warranties, messages] = await Promise.all([
      db.query('SELECT * FROM vehicles WHERE contact_id = $1 ORDER BY created_at', [id]),
      db.query('SELECT * FROM properties WHERE contact_id = $1 ORDER BY created_at', [id]),
      db.query('SELECT * FROM jobs WHERE contact_id = $1 ORDER BY created_at DESC', [id]),
      db.query('SELECT * FROM warranties WHERE contact_id = $1 ORDER BY starts_on DESC', [id]),
      db.query('SELECT * FROM messages WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 100', [id]),
    ]);
    res.json({ ...contact, vehicles: vehicles.rows, properties: properties.rows, jobs: jobs.rows,
      warranties: warranties.rows, messages: messages.rows });
  });

  r.patch('/contacts/:id', async (req, res) => {
    const id = idParam(req.params.id, 'Contact');
    await mustExist(db, 'contacts', id, 'Contact');
    const c = contactInput.partial().parse(req.body);
    const fields = Object.entries(c).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return res.json((await db.query('SELECT * FROM contacts WHERE id = $1', [id])).rows[0]);
    const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await db.query(`UPDATE contacts SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...fields.map(([, v]) => v)]);
    res.json(rows[0]);
  });

  r.post('/contacts/:id/vehicles', async (req, res) => {
    const id = idParam(req.params.id, 'Contact');
    await mustExist(db, 'contacts', id, 'Contact');
    res.status(201).json(await insertVehicle(db, id, vehicleInput.parse(req.body)));
  });

  r.post('/contacts/:id/properties', async (req, res) => {
    const id = idParam(req.params.id, 'Contact');
    await mustExist(db, 'contacts', id, 'Contact');
    const p = z.object({
      address: z.string().trim().min(3).max(300),
      city: optText, zip: optText,
      type: z.enum(['residential', 'commercial']),
      window_count: z.number().int().min(0).max(10000).nullish(),
      glass_notes: optText,
    }).parse(req.body);
    const { rows } = await db.query(
      `INSERT INTO properties (contact_id, address, city, zip, type, window_count, glass_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, p.address, p.city ?? null, p.zip ?? null, p.type, p.window_count ?? null, p.glass_notes ?? null],
    );
    res.status(201).json(rows[0]);
  });

  /**
   * Quick lead: one form → contact (reused if the mobile exists) + vehicle + job in New lead.
   * Runs in one transaction so a half-created lead can never exist.
   */
  r.post('/leads', async (req, res) => {
    const input = quickLeadInput.parse(req.body);
    const out = await db.tx(async (q) => {
      const c = input.contact;
      const found = await q.query('SELECT * FROM contacts WHERE mobile = $1', [c.mobile]);
      let contact = found.rows[0];
      const reused = !!contact;
      if (!contact) {
        contact = (await q.query(
          `INSERT INTO contacts (first_name, last_name, mobile, email, language, preferred_channel, ig_handle, lead_source, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [c.first_name ?? null, c.last_name ?? null, c.mobile, c.email ?? null, c.language, c.preferred_channel,
           c.ig_handle ?? null, input.lead_source ?? c.lead_source ?? null, c.tags],
        )).rows[0];
      }
      const vehicle = input.vehicle ? await insertVehicle(q, contact.id, input.vehicle) : null;
      const job = (await q.query(
        `INSERT INTO jobs (contact_id, vehicle_id, lead_source) VALUES ($1,$2,$3) RETURNING *`,
        [contact.id, vehicle?.id ?? null, input.lead_source ?? contact.lead_source ?? null],
      )).rows[0];
      if (input.note) {
        await q.query(`INSERT INTO notes (subject_type, subject_id, body) VALUES ('job', $1, $2)`, [job.id, input.note]);
      }
      await logActivity(q, 'job', job.id, 'created', { via: 'quick_lead' });
      return { contact, vehicle, job, reused_contact: reused };
    });
    res.status(201).json(out);
  });

  r.post('/notes', async (req, res) => {
    const n = z.object({
      subject_type: z.enum(['contact', 'vehicle', 'property', 'job', 'warranty', 'claim']),
      subject_id: z.uuid(),
      type: z.enum(['general', 'call', 'text', 'internal', 'install', 'inspection']).default('general'),
      body: z.string().trim().min(1).max(5000),
      pinned: z.boolean().default(false),
    }).parse(req.body);
    const table = { contact: 'contacts', vehicle: 'vehicles', property: 'properties', job: 'jobs',
      warranty: 'warranties', claim: 'warranty_claims' }[n.subject_type];
    const exists = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [n.subject_id]);
    if (!exists.rows[0]) throw conflict('subject_missing', `That ${n.subject_type} does not exist`);
    const { rows } = await db.query(
      `INSERT INTO notes (subject_type, subject_id, type, body, pinned) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [n.subject_type, n.subject_id, n.type, n.body, n.pinned],
    );
    res.status(201).json(rows[0]);
  });

  r.get('/notes', async (req, res) => {
    const subjectType = z.enum(['contact', 'vehicle', 'property', 'job', 'warranty', 'claim']).parse(req.query.subject_type);
    const subjectId = z.uuid().parse(req.query.subject_id);
    const { rows } = await db.query(
      `SELECT * FROM notes WHERE subject_type = $1 AND subject_id = $2 ORDER BY pinned DESC, created_at DESC`,
      [subjectType, subjectId],
    );
    res.json(rows);
  });

  return r;
}
