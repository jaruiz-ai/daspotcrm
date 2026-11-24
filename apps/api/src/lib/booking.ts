import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import { conflict } from './errors.js';
import { assert, logActivity } from '../routes/shared.js';

export const slotInput = z.object({
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  bay: z.number().int().min(1).max(20).default(1),
  installer_id: z.uuid().nullish(),
});
export type Slot = z.infer<typeof slotInput>;

/**
 * Books a time slot for a job that is already locked in this transaction.
 * One appointment per bay per time; a new lead or a quote moves to Booked.
 */
export async function bookAppointment(q: Queryable, job: { id: string; stage: string }, b: Slot) {
  assert(new Date(b.ends_at) > new Date(b.starts_at), 'bad_time_range', 'End time must be after start time');
  assert(['new_lead', 'quoted', 'booked'].includes(job.stage), 'job_not_bookable',
    'Only open jobs that are not yet in the bay can be booked');
  await assertBayFree(q, b.bay, b.starts_at, b.ends_at);
  const appt = (await q.query(
    `INSERT INTO appointments (job_id, starts_at, ends_at, bay, installer_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [job.id, b.starts_at, b.ends_at, b.bay, b.installer_id ?? null],
  )).rows[0];
  if (job.stage === 'new_lead' || job.stage === 'quoted') {
    await q.query(`UPDATE jobs SET stage = 'booked', updated_at = now() WHERE id = $1`, [job.id]);
    await logActivity(q, 'job', job.id, 'stage_changed', { from: job.stage, to: 'booked', auto: true });
  }
  return appt;
}

/** Throws bay_taken when another live appointment overlaps. Locks the rows it checks, so two bookings can't race. */
export async function assertBayFree(q: Queryable, bay: number, startsAt: string, endsAt: string, exceptAppointmentId?: string) {
  const clash = await q.query(
    `SELECT a.id, j.number FROM appointments a JOIN jobs j ON j.id = a.job_id
      WHERE a.bay = $1 AND a.status NOT IN ('cancelled','no_show','done')
        AND tstzrange(a.starts_at, a.ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
        AND ($4::uuid IS NULL OR a.id <> $4::uuid)
      FOR UPDATE OF a`,
    [bay, startsAt, endsAt, exceptAppointmentId ?? null],
  );
  if (clash.rows[0]) throw conflict('bay_taken', `Bay ${bay} is already booked then (job #${clash.rows[0].number})`);
}

/**
 * After an appointment is cancelled: a Booked job with nothing else on the schedule goes back to
 * Quoted, so it shows up as needing a new time instead of looking booked.
 */
export async function unbookIfNoAppointments(q: Queryable, jobId: string) {
  const job = (await q.query('SELECT stage FROM jobs WHERE id = $1', [jobId])).rows[0];
  if (job?.stage !== 'booked') return;
  const live = await q.query(
    `SELECT 1 FROM appointments WHERE job_id = $1 AND status IN ('scheduled','confirmed') LIMIT 1`, [jobId]);
  if (live.rows[0]) return;
  await q.query(`UPDATE jobs SET stage = 'quoted', updated_at = now() WHERE id = $1`, [jobId]);
  await logActivity(q, 'job', jobId, 'stage_changed', { from: 'booked', to: 'quoted', auto: true, reason: 'appointment_cancelled' });
}
