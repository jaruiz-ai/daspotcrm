import type { Queryable } from '../db/index.js';

export interface JobTotals {
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
}

/** Tax is applied after discount and rounded half-up to the cent. */
export function computeTotals(subtotal: number, discount: number, taxRateBp: number, paid: number): JobTotals {
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round((taxable * taxRateBp) / 10000);
  const total = taxable + tax;
  return {
    subtotal_cents: subtotal,
    discount_cents: Math.min(discount, subtotal),
    tax_cents: tax,
    total_cents: total,
    paid_cents: paid,
    balance_cents: total - paid,
  };
}

export async function jobTotals(q: Queryable, jobId: string): Promise<JobTotals> {
  const { rows } = await q.query<{ subtotal: string; discount: number; tax_rate_bp: number; paid: string }>(
    `SELECT
       COALESCE((SELECT SUM(qty::bigint * unit_price_cents) FROM job_line_items WHERE job_id = j.id), 0) AS subtotal,
       j.discount_cents AS discount,
       j.tax_rate_bp,
       COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_cents ELSE amount_cents END)
                 FROM payments WHERE job_id = j.id), 0) AS paid
     FROM jobs j WHERE j.id = $1`,
    [jobId],
  );
  const r = rows[0];
  if (!r) throw new Error('job not found');
  return computeTotals(Number(r.subtotal), r.discount, r.tax_rate_bp, Number(r.paid));
}
