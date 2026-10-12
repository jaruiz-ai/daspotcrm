import type { Queryable } from '../db/index.js';

export const SHOP_TZ = 'America/Chicago';

/**
 * Issues warranties for a completed, fully paid job. Idempotent: running it twice
 * creates nothing new. Warranty re-do jobs keep the original warranty and issue none.
 * One manufacturer warranty per film line used, plus one shop labor warranty
 * (longest labor term among the films used).
 */
export async function issueWarranties(q: Queryable, jobId: string): Promise<number> {
  const { rows: jobs } = await q.query(
    `SELECT id, number, contact_id, vehicle_id, property_id, completed_at, is_warranty_redo FROM jobs WHERE id = $1`,
    [jobId],
  );
  const job = jobs[0];
  if (!job || job.is_warranty_redo || !job.completed_at) return 0;

  const { rows: films } = await q.query(
    `SELECT f.brand, f.line, f.warranty_term_months, f.labor_warranty_months,
            array_agg(DISTINCT w) FILTER (WHERE w IS NOT NULL) AS windows
       FROM job_line_items li
       JOIN film_products f ON f.id = li.film_product_id
       LEFT JOIN LATERAL unnest(CASE WHEN cardinality(li.windows) = 0 THEN ARRAY[li.service] ELSE li.windows END) AS w ON true
      WHERE li.job_id = $1
      GROUP BY f.brand, f.line, f.warranty_term_months, f.labor_warranty_months
      ORDER BY f.brand, f.line`,
    [jobId],
  );
  if (films.length === 0) return 0;

  // Warranty starts on the shop-local calendar day the job was completed.
  const startExpr = `(($1::timestamptz) AT TIME ZONE '${SHOP_TZ}')::date`;
  let created = 0;
  let seq = 0;
  for (const f of films) {
    seq += 1;
    const r = await q.query(
      `INSERT INTO warranties (number, job_id, contact_id, vehicle_id, property_id, coverage, film_brand, film_line,
                               windows_covered, starts_on, expires_on)
       VALUES ($2, $3, $4, $5, $6, 'manufacturer', $7, $8, $9, ${startExpr},
               CASE WHEN $10::int IS NULL THEN NULL ELSE (${startExpr} + make_interval(months => $10::int))::date END)
       ON CONFLICT (job_id, coverage, film_brand, film_line) DO NOTHING
       RETURNING id`,
      [job.completed_at, `DS-${job.number}-M${seq}`, job.id, job.contact_id, job.vehicle_id, job.property_id,
       f.brand, f.line, f.windows ?? [], f.warranty_term_months],
    );
    created += r.rows.length;
  }

  const laborMonths = films
    .map((f) => f.labor_warranty_months as number | null)
    .filter((m): m is number => m != null);
  if (laborMonths.length) {
    const allWindows = [...new Set(films.flatMap((f) => (f.windows ?? []) as string[]))];
    const r = await q.query(
      `INSERT INTO warranties (number, job_id, contact_id, vehicle_id, property_id, coverage, film_brand, film_line,
                               windows_covered, starts_on, expires_on)
       VALUES ($2, $3, $4, $5, $6, 'labor', 'Da Spot 214', 'Installation', $7, ${startExpr},
               (${startExpr} + make_interval(months => $8::int))::date)
       ON CONFLICT (job_id, coverage, film_brand, film_line) DO NOTHING
       RETURNING id`,
      [job.completed_at, `DS-${job.number}-L1`, job.id, job.contact_id, job.vehicle_id, job.property_id,
       allWindows, Math.max(...laborMonths)],
    );
    created += r.rows.length;
  }
  if (created) {
    await q.query(`INSERT INTO activity (subject_type, subject_id, type, payload) VALUES ('job', $1, 'warranty_issued', $2)`,
      [jobId, JSON.stringify({ count: created })]);
  }
  return created;
}
