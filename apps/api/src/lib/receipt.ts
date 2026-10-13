import type { Deps } from '../app.js';
import { jobTotals } from './money.js';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function fmtDate(iso: string, lang: 'en' | 'es') {
  const [y, m, d] = iso.split('-').map(Number);
  const months = lang === 'es'
    ? ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
    : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return lang === 'es' ? `${d} ${months.at(m - 1)} ${y}` : `${months.at(m - 1)} ${d}, ${y}`;
}

export interface ReceiptInput {
  firstName: string | null;
  jobNumber: number;
  totalCents: number;
  warranties: { number: string; coverage: string; film_line: string | null; expires_on: string | null }[];
}

/** The text a customer gets when their job is paid in full: amount, warranty numbers, aftercare. */
export function receiptText(lang: 'en' | 'es', r: ReceiptInput): string {
  const w = r.warranties.map((x) => {
    const what = x.coverage === 'labor' ? (lang === 'es' ? 'mano de obra' : 'labor') : x.film_line ?? 'film';
    const until = x.expires_on
      ? (lang === 'es' ? `hasta ${fmtDate(x.expires_on, lang)}` : `until ${fmtDate(x.expires_on, lang)}`)
      : (lang === 'es' ? 'de por vida' : 'lifetime');
    return `${x.number} (${what}, ${until})`;
  });
  if (lang === 'es') {
    return [
      `¡Gracias${r.firstName ? `, ${r.firstName}` : ''}! Recibimos su pago de ${money(r.totalCents)} por el trabajo #${r.jobNumber}.`,
      w.length ? `Sus garantías: ${w.join('; ')}.` : null,
      'Mantenga las ventanas cerradas unos días mientras cura el polarizado. Da Spot 214',
    ].filter(Boolean).join(' ');
  }
  return [
    `Thanks${r.firstName ? `, ${r.firstName}` : ''}! We received your ${money(r.totalCents)} payment for job #${r.jobNumber}.`,
    w.length ? `Your warranties: ${w.join('; ')}.` : null,
    'Keep your windows up for a few days while the film cures. Da Spot 214',
  ].filter(Boolean).join(' ');
}

/**
 * Texts the receipt after a job moves to Paid. Runs after the payment commits, so a texting
 * failure never undoes a payment; it leaves a task for the desk instead.
 */
export async function sendPaidReceipt({ db, sender }: Pick<Deps, 'db' | 'sender'>, jobId: string): Promise<void> {
  const job = (await db.query(
    `SELECT j.id, j.number, j.contact_id, j.is_warranty_redo, c.first_name, c.mobile, c.language, c.preferred_channel, c.sms_opt_in
       FROM jobs j JOIN contacts c ON c.id = j.contact_id WHERE j.id = $1`, [jobId])).rows[0];
  if (!job || !job.sms_opt_in || job.is_warranty_redo) return;
  const totals = await jobTotals(db, jobId);
  if (totals.total_cents <= 0) return;
  const warranties = (await db.query(
    `SELECT number, coverage, film_line, expires_on FROM warranties WHERE job_id = $1 AND status <> 'voided' ORDER BY number`,
    [jobId])).rows;
  const body = receiptText(job.language, { firstName: job.first_name, jobNumber: job.number, totalCents: totals.total_cents, warranties });
  try {
    const sent = await sender.send({ to: job.mobile, channel: job.preferred_channel, body });
    await db.query(
      `INSERT INTO messages (contact_id, job_id, channel, direction, body, external_id) VALUES ($1,$2,$3,'out',$4,$5)`,
      [job.contact_id, jobId, job.preferred_channel, body, sent.externalId]);
  } catch (err) {
    console.error('receipt text failed', err);
    await db.query(
      `INSERT INTO tasks (title, due_at, subject_type, subject_id, auto_rule)
       VALUES ($1, now(), 'job', $2, 'receipt_failed')`,
      [`Receipt text failed for job #${job.number}. Text the customer their warranty numbers.`, jobId]);
  }
}
