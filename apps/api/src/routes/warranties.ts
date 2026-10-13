import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { conflict, notFound } from '../lib/errors.js';
import { toE164 } from '../lib/phone.js';
import { assert, idParam, logActivity, optText } from './shared.js';

/** Lowercase and drop accents so "Ramirez" finds "Ramírez" (and the other way round). */
const ACCENTED = 'áàâäãåéèêëíìîïóòôöõúùûüñçý';
const PLAIN = 'aaaaaaeeeeiiiiooooouuuuncy';
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const FOLD_SQL = (expr: string) => `translate(lower(${expr}), '${ACCENTED}', '${PLAIN}')`;

export function warrantiesRouter({ db }: Deps) {
  const r = Router();

  /** Find warranties by phone, plate, VIN, warranty number, customer name or email. */
  r.get('/warranties/lookup', async (req, res) => {
    const raw = String(req.query.q ?? '').trim().replace(/\s+/g, ' ');
    assert(raw.length >= 3, 'query_too_short', 'Enter at least 3 characters');
    const upper = raw.toUpperCase().replace(/\s+/g, '');
    const mobile = toE164(raw);
    // Email: exact match, any case. Name: only for text with no digits, so a plate never matches a name.
    const email = raw.includes('@') ? raw.toLowerCase() : null;
    const name = !email && /^[\p{L}][\p{L} .'-]*$/u.test(raw)
      ? '%' + fold(raw).replace(/[%_\\]/g, (m) => '\\' + m) + '%'
      : null;
    const { rows } = await db.query(
      `SELECT w.*, c.first_name, c.last_name, c.mobile, c.email, v.year, v.make, v.model, v.plate, v.vin,
              (w.expires_on IS NULL OR w.expires_on >= (now() AT TIME ZONE 'America/Chicago')::date) AS in_term,
              (SELECT COUNT(*)::int FROM warranty_claims wc WHERE wc.warranty_id = w.id) AS claim_count
         FROM warranties w
         JOIN contacts c ON c.id = w.contact_id
         LEFT JOIN vehicles v ON v.id = w.vehicle_id
        WHERE upper(w.number) = $1
           OR ($2::text IS NOT NULL AND c.mobile = $2)
           OR upper(replace(v.plate, ' ', '')) = $1
           OR upper(v.vin) = $1
           OR ($3::text IS NOT NULL AND lower(c.email) = $3)
           OR ($4::text IS NOT NULL AND (
                ${FOLD_SQL("trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))")} LIKE $4
             OR ${FOLD_SQL("trim(coalesce(c.last_name, '') || ' ' || coalesce(c.first_name, ''))")} LIKE $4))
        ORDER BY c.last_name NULLS LAST, c.first_name, w.starts_on DESC, w.number
        LIMIT 100`,
      [upper, mobile, email, name],
    );
    res.json(rows);
  });

  r.post('/warranties/:id/void', async (req, res) => {
    const id = idParam(req.params.id, 'Warranty');
    const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const { rows } = await db.query(
      `UPDATE warranties SET status = 'voided', void_reason = $2 WHERE id = $1 AND status <> 'voided' RETURNING *`, [id, b.reason]);
    if (!rows[0]) {
      const exists = await db.query('SELECT 1 FROM warranties WHERE id = $1', [id]);
      if (!exists.rows[0]) throw notFound('Warranty');
      throw conflict('already_voided', 'Warranty is already voided');
    }
    res.json(rows[0]);
  });

  r.post('/warranties/:id/claims', async (req, res) => {
    const id = idParam(req.params.id, 'Warranty');
    const b = z.object({
      issue: z.enum(['bubbling', 'peeling', 'fading', 'edge_lift', 'contamination', 'other']),
      description: optText,
    }).parse(req.body);
    const w = (await db.query(
      `SELECT *, (expires_on IS NULL OR expires_on >= (now() AT TIME ZONE 'America/Chicago')::date) AS in_term
         FROM warranties WHERE id = $1`, [id])).rows[0];
    if (!w) throw notFound('Warranty');
    assert(w.status !== 'voided', 'warranty_voided', `This warranty was voided: ${w.void_reason ?? 'no reason given'}`);
    const { rows } = await db.query(
      `INSERT INTO warranty_claims (warranty_id, issue, description) VALUES ($1,$2,$3) RETURNING *`,
      [id, b.issue, b.description ?? null]);
    await db.query(
      `INSERT INTO tasks (title, due_at, subject_type, subject_id, auto_rule)
       VALUES ($1, now() + interval '1 day', 'claim', $2, 'claim_inspection')`,
      [`Inspect warranty claim ${w.number} (${b.issue})`, rows[0].id]);
    res.status(201).json({ ...rows[0], warranty_in_term: w.in_term });
  });

  /**
   * Decide a claim. Covered or goodwill creates a linked no-charge re-do job in New lead,
   * on the same vehicle or property, flagged so it issues no new warranty.
   */
  r.post('/claims/:id/decision', async (req, res) => {
    const id = idParam(req.params.id, 'Claim');
    const b = z.object({ decision: z.enum(['covered', 'not_covered', 'goodwill']) }).parse(req.body);
    const out = await db.tx(async (q) => {
      const claim = (await q.query('SELECT * FROM warranty_claims WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!claim) throw notFound('Claim');
      assert(claim.decision === 'pending', 'already_decided', 'This claim has already been decided');
      const w = (await q.query('SELECT * FROM warranties WHERE id = $1', [claim.warranty_id])).rows[0];
      let redo = null;
      if (b.decision !== 'not_covered') {
        redo = (await q.query(
          `INSERT INTO jobs (contact_id, vehicle_id, property_id, lead_source, parent_claim_id, is_warranty_redo)
           VALUES ($1,$2,$3,'warranty',$4,true) RETURNING *`,
          [w.contact_id, w.vehicle_id, w.property_id, id])).rows[0];
        await logActivity(q, 'job', redo.id, 'created', { via: 'warranty_claim', claim_id: id });
      }
      const updated = (await q.query(
        `UPDATE warranty_claims SET decision = $2, resolution_job_id = $3 WHERE id = $1 RETURNING *`,
        [id, b.decision, redo?.id ?? null])).rows[0];
      return { claim: updated, redo_job: redo };
    });
    res.json(out);
  });

  return r;
}
