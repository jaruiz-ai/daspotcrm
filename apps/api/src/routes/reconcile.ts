import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { badRequest } from '../lib/errors.js';
import { dayDiff, normHeader, parseCsv, parseDay, parseMinutes, parseMoney } from '../lib/csv.js';
import { SHOP_TZ } from '../lib/warranty.js';

interface ChaseRow {
  line: number;
  day: string;
  minutes: number | null; // time of day, when the report has it
  amount_cents: number; // card amount without tip
  tip_cents: number;
  kind: 'sale' | 'refund';
  transaction_id: string | null;
  card: string | null;
}

const FIND: Record<string, (h: string) => boolean> = {
  date: (h) => /\b(date|settled|processed)\b/.test(h) && !/\b(batch|deposit|funding)\b/.test(h),
  time: (h) => /\btime\b/.test(h),
  amount: (h) => /\b(amount|total|sale)\b/.test(h) && !/\b(tip|gratuity|fee|tax|discount|surcharge)\b/.test(h),
  tip: (h) => /\b(tip|gratuity)\b/.test(h),
  type: (h) => /\btype\b/.test(h),
  status: (h) => /\b(status|result|response)\b/.test(h),
  id: (h) => /\b(transaction id|transaction|reference|ref|auth|authorization|approval)\b/.test(h) && !/\btype\b/.test(h),
  card: (h) => /\b(card|last 4|last four|account)\b/.test(h) && !/\b(type|brand)\b/.test(h),
};
const PREFER: Record<string, RegExp> = {
  date: /transaction date|date/, amount: /transaction amount|sale amount|^amount$|amount/, id: /transaction id/,
};

/** Finds the header row (exports often start with a title or summary) and the columns we need. */
function readChaseCsv(text: string) {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r, i) => i < 15 && r.some((c) => FIND.date(normHeader(c))) && r.some((c) => FIND.amount(normHeader(c))));
  if (headerIdx < 0) {
    throw badRequest('unrecognized_report', 'Could not find the date and amount columns. Upload the transactions report from Chase as a CSV file.');
  }
  const headers = rows[headerIdx].map(normHeader);
  const col: Record<string, number> = {};
  for (const key of Object.keys(FIND)) {
    const hits = headers.map((h, i) => [h, i] as const).filter(([h]) => FIND[key](h));
    if (!hits.length) continue;
    const pref = PREFER[key];
    col[key] = (pref ? hits.find(([h]) => pref.test(h)) ?? hits[0] : hits[0])[1];
  }

  const sales: ChaseRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const cell = (k: string) => (col[k] != null ? r[col[k]] ?? '' : '');
    const status = cell('status').toLowerCase();
    const type = cell('type').toLowerCase();
    if (/total|summary/.test(r.join(' ').toLowerCase()) && !parseDay(cell('date'))) continue; // footer rows
    if (/declin|void|fail|error|cancel|reject/.test(status) || /void|auth only|pre ?auth|verify/.test(type)) {
      skipped.push({ line, reason: `Not a completed sale (${cell('status') || cell('type')})` });
      continue;
    }
    const day = parseDay(cell('date'));
    const gross = parseMoney(cell('amount'));
    if (!day || gross == null) {
      skipped.push({ line, reason: !day ? 'No readable date' : 'No readable amount' });
      continue;
    }
    if (gross === 0) { skipped.push({ line, reason: 'Zero amount' }); continue; }
    const isRefund = gross < 0 || /refund|return|credit/.test(type);
    const tip = Math.abs(parseMoney(cell('tip')) ?? 0);
    const absAmount = Math.abs(gross);
    sales.push({
      line, day, minutes: parseMinutes(cell('time')) ?? parseMinutes(cell('date').replace(/^\S+/, '')),
      kind: isRefund ? 'refund' : 'sale', tip_cents: tip,
      // Tips go to the installer, not the job, so they are left out of the match.
      amount_cents: Math.max(0, absAmount - (isRefund ? 0 : tip)),
      transaction_id: cell('id') || null,
      card: cell('card').replace(/[^0-9]/g, '').slice(-4) || null,
    });
  }
  return { sales, skipped, columns: Object.fromEntries(Object.entries(col).map(([k, i]) => [k, rows[headerIdx][i]])) };
}

export function reconcileRouter({ db }: Deps) {
  const r = Router();

  /**
   * Compares a Chase card-sales report with card payments recorded in the CRM.
   * Read-only: nothing is saved. Staff record any missing payment from the result.
   */
  r.post('/reconcile/chase', async (req, res) => {
    const { csv } = z.object({ csv: z.string().min(1).max(2_000_000) }).parse(req.body);
    const { sales, skipped, columns } = readChaseCsv(csv);
    if (!sales.length) throw badRequest('no_sales', 'The report has no completed card sales in it.');

    const days = sales.map((s) => s.day).sort();
    const from = days[0];
    const to = days.at(-1)!;

    const { rows: payments } = await db.query(
      `SELECT p.id, p.job_id, p.amount_cents, p.kind, p.external_ref,
              ((p.paid_at AT TIME ZONE '${SHOP_TZ}')::date)::text AS day,
              (extract(hour FROM p.paid_at AT TIME ZONE '${SHOP_TZ}') * 60 + extract(minute FROM p.paid_at AT TIME ZONE '${SHOP_TZ}'))::int AS minutes,
              j.number, c.first_name, c.last_name, c.mobile
         FROM payments p JOIN jobs j ON j.id = p.job_id JOIN contacts c ON c.id = j.contact_id
        WHERE p.method = 'card'
          AND (p.paid_at AT TIME ZONE '${SHOP_TZ}')::date BETWEEN ($1::date - 1) AND ($2::date + 1)
        ORDER BY p.paid_at`,
      [from, to],
    );

    const used = new Set<string>();
    const matched: any[] = [];
    const missing: ChaseRow[] = [];
    const ref = (s: ChaseRow) => (s.transaction_id ? `chase:${s.transaction_id}` : null);

    // 1) Exact: a payment recorded from this report earlier carries the Chase transaction id.
    const pending: ChaseRow[] = [];
    for (const s of sales) {
      const p = ref(s) ? payments.find((x) => !used.has(x.id) && x.external_ref === ref(s)) : null;
      if (p) { used.add(p.id); matched.push({ chase: s, payment: p }); } else pending.push(s);
    }
    // 2) Same amount, same kind, closest day within one day either side.
    for (const s of pending) {
      const want = s.kind === 'refund' ? ['refund'] : ['deposit', 'balance'];
      const candidates = payments
        .filter((p) => !used.has(p.id) && want.includes(p.kind) && p.amount_cents === s.amount_cents && Math.abs(dayDiff(p.day, s.day)) <= 1)
        // Closest day first; on the same day, closest time of day when the report has times.
        .sort((a, b) => {
          const byDay = Math.abs(dayDiff(a.day, s.day)) - Math.abs(dayDiff(b.day, s.day));
          if (byDay !== 0 || s.minutes == null) return byDay;
          return Math.abs(a.minutes - s.minutes) - Math.abs(b.minutes - s.minutes);
        });
      if (candidates[0]) { used.add(candidates[0].id); matched.push({ chase: s, payment: candidates[0] }); } else missing.push(s);
    }
    // Card payments in the CRM, inside the report's dates, that Chase doesn't show.
    const extra = payments.filter((p) => !used.has(p.id) && p.day >= from && p.day <= to);

    // For each missing sale, suggest open jobs whose balance equals the amount.
    const { rows: open } = await db.query(
      `SELECT j.id, j.number, j.stage, c.first_name, c.last_name, c.mobile, v.year, v.make, v.model,
              (COALESCE((SELECT SUM(qty::bigint * unit_price_cents) FROM job_line_items WHERE job_id = j.id), 0) - j.discount_cents) AS pretax,
              j.tax_rate_bp,
              COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_cents ELSE amount_cents END) FROM payments WHERE job_id = j.id), 0) AS paid
         FROM jobs j JOIN contacts c ON c.id = j.contact_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
        WHERE j.stage NOT IN ('lost', 'paid')`);
    const openJobs = open.map((j) => {
      const taxable = Math.max(0, Number(j.pretax));
      const total = taxable + Math.round((taxable * j.tax_rate_bp) / 10000);
      return { id: j.id, number: j.number, stage: j.stage, first_name: j.first_name, last_name: j.last_name, mobile: j.mobile,
        vehicle: [j.year, j.make, j.model].filter(Boolean).join(' '), balance_cents: total - Number(j.paid) };
    });

    res.json({
      range: { from, to },
      columns,
      counts: { sales: sales.length, matched: matched.length, missing: missing.length, extra: extra.length, skipped: skipped.length },
      matched,
      missing: missing.map((s) => ({
        ...s,
        suggestions: s.kind === 'sale' ? openJobs.filter((j) => j.balance_cents === s.amount_cents).slice(0, 5) : [],
      })),
      extra,
      skipped,
    });
  });

  return r;
}
