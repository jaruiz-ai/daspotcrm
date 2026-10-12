import type { Queryable } from '../db/index.js';
import { jobTotals } from './money.js';
import { SHOP_TZ } from './warranty.js';

/**
 * Writes payout ledger lines for a payment on an attributed job.
 * Basis is the pre-tax share of the payment (sales tax is not revenue).
 * Refunds produce negative lines. Idempotent per (payment, rule).
 */
export async function recordRevShare(q: Queryable, paymentId: string): Promise<number> {
  const { rows } = await q.query(
    `SELECT p.id, p.job_id, p.amount_cents, p.kind, p.paid_at, j.lead_source,
            to_char((p.paid_at AT TIME ZONE '${SHOP_TZ}'), 'YYYY-MM') AS period,
            ((p.paid_at AT TIME ZONE '${SHOP_TZ}')::date) AS paid_day
       FROM payments p JOIN jobs j ON j.id = p.job_id WHERE p.id = $1`,
    [paymentId],
  );
  const pay = rows[0];
  if (!pay) return 0;

  const { rows: rules } = await q.query(
    `SELECT id, partner_id, percent_bp, basis FROM rev_share_rules
      WHERE starts_on <= $1::date AND (ends_on IS NULL OR ends_on >= $1::date)
        AND (cardinality(sources) = 0 OR $2 = ANY(sources))`,
    [pay.paid_day, pay.lead_source],
  );
  if (rules.length === 0) return 0;

  const totals = await jobTotals(q, pay.job_id);
  const preTaxRatio = totals.total_cents > 0 ? (totals.total_cents - totals.tax_cents) / totals.total_cents : 1;
  const sign = pay.kind === 'refund' ? -1 : 1;
  const basis = sign * Math.round(pay.amount_cents * preTaxRatio);

  let n = 0;
  for (const rule of rules) {
    const share = Math.round((basis * rule.percent_bp) / 10000);
    const r = await q.query(
      `INSERT INTO payout_lines (partner_id, rule_id, job_id, payment_id, period, basis_cents, share_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (payment_id, rule_id) DO NOTHING RETURNING id`,
      [rule.partner_id, rule.id, pay.job_id, pay.id, pay.period, basis, share],
    );
    n += r.rows.length;
  }
  return n;
}
