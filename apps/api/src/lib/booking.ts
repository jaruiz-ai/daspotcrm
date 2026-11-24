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
  // Serialize bookings per bay: lock existing appointments in the bay before checking overlap.
  const clash = await q.query(
    `SELECT a.id, j.number FROM appointments a JOIN jobs j ON j.id = a.job_id
      WHERE a.bay = $1 AND a.status NOT IN ('cancelled','no_show','done')
        AND tstzrange(a.starts_at, a.ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
      FOR UPDATE OF a`,
    [b.bay, b.starts_at, b.ends_at],
  );
  if (clash.rows[0]) throw conflict('bay_taken', `Bay ${b.bay} is already booked then (job #${clash.rows[0].number})`);
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
