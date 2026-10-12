import { z } from 'zod';
import { toE164 } from '../lib/phone.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { Queryable } from '../db/index.js';

export const uuid = z.uuid();

export const idParam = (raw: unknown, what = 'Record') => {
  const r = uuid.safeParse(raw);
  if (!r.success) throw notFound(what);
  return r.data;
};

export const phone = z.string().transform((v, ctx) => {
  const e164 = toE164(v);
  if (!e164) {
    ctx.addIssue({ code: 'custom', message: 'Not a valid phone number' });
    return z.NEVER;
  }
  return e164;
});

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const optText = z.preprocess(blankToNull, z.string().trim().max(500).nullish());

export const vehicleInput = z.object({
  year: z.coerce.number().int().min(1950).max(new Date().getFullYear() + 2).nullish(),
  make: optText,
  model: optText,
  trim: optText,
  body_type: z.enum(['sedan', 'coupe', 'suv', 'truck', 'van', 'other']).nullish(),
  color: optText,
  plate: z.preprocess(blankToNull, z.string().trim().toUpperCase().max(10).nullish()),
  vin: z.preprocess(blankToNull, z.string().trim().toUpperCase().regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'VIN must be 17 characters (no I, O or Q)').nullish()),
  has_pano_roof: z.boolean().optional(),
});
export type VehicleInput = z.infer<typeof vehicleInput>;

export async function insertVehicle(q: Queryable, contactId: string, v: VehicleInput) {
  const { rows } = await q.query(
    `INSERT INTO vehicles (contact_id, year, make, model, trim, body_type, color, plate, vin, has_pano_roof)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [contactId, v.year ?? null, v.make ?? null, v.model ?? null, v.trim ?? null, v.body_type ?? null,
     v.color ?? null, v.plate ?? null, v.vin ?? null, v.has_pano_roof ?? false],
  );
  return rows[0];
}

export async function mustExist(q: Queryable, table: 'contacts' | 'jobs' | 'warranties' | 'warranty_claims' | 'partners', id: string, what: string) {
  const { rows } = await q.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(what);
  return rows[0];
}

export function assert(cond: unknown, code: string, message: string): asserts cond {
  if (!cond) throw badRequest(code, message);
}

export async function logActivity(q: Queryable, subjectType: string, subjectId: string, type: string, payload: object = {}) {
  await q.query(`INSERT INTO activity (subject_type, subject_id, type, payload) VALUES ($1,$2,$3,$4)`,
    [subjectType, subjectId, type, JSON.stringify(payload)]);
}
