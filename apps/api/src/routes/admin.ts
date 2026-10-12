import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { assert, idParam, mustExist } from './shared.js';

export function adminRouter({ db }: Deps) {
  const r = Router();

  r.get('/film-products', async (_req, res) => {
    res.json((await db.query('SELECT * FROM film_products ORDER BY active DESC, brand, line')).rows);
  });

  r.post('/film-products', async (req, res) => {
    const f = z.object({
      brand: z.string().trim().min(1).max(80),
      line: z.string().trim().min(1).max(80),
      tier: z.enum(['carbon', 'carbon-ceramic', 'nano-ceramic', 'wrap-vinyl', 'architectural']),
      cost_per_ft_cents: z.number().int().min(0).default(0),
      warranty_term_months: z.number().int().min(1).max(1200).nullable().default(null),
      labor_warranty_months: z.number().int().min(1).max(1200).nullable().default(null),
    }).parse(req.body);
    const { rows } = await db.query(
      `INSERT INTO film_products (brand, line, tier, cost_per_ft_cents, warranty_term_months, labor_warranty_months)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [f.brand, f.line, f.tier, f.cost_per_ft_cents, f.warranty_term_months, f.labor_warranty_months]);
    res.status(201).json(rows[0]);
  });

  r.post('/partners', async (req, res) => {
    const p = z.object({ name: z.string().trim().min(1).max(120), email: z.email().nullish() }).parse(req.body);
    const { rows } = await db.query('INSERT INTO partners (name, email) VALUES ($1,$2) RETURNING *', [p.name, p.email ?? null]);
    res.status(201).json(rows[0]);
  });

  r.post('/partners/:id/rules', async (req, res) => {
    const id = idParam(req.params.id, 'Partner');
    await mustExist(db, 'partners', id, 'Partner');
    const b = z.object({
      percent: z.number().gt(0).max(100),
      // Net-of-material needs film usage tracking (Phase 2); only gross is supported for now.
      basis: z.literal('gross').default('gross'),
      sources: z.array(z.string().trim().min(1)).default([]),
      starts_on: z.iso.date(),
      ends_on: z.iso.date().nullish(),
    }).parse(req.body);
    assert(!b.ends_on || b.ends_on >= b.starts_on, 'bad_date_range', 'End date must be on or after start date');
    const { rows } = await db.query(
      `INSERT INTO rev_share_rules (partner_id, percent_bp, basis, sources, starts_on, ends_on)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, Math.round(b.percent * 100), b.basis, b.sources, b.starts_on, b.ends_on ?? null]);
    res.status(201).json(rows[0]);
  });

  r.get('/partners/:id/payouts', async (req, res) => {
    const id = idParam(req.params.id, 'Partner');
    await mustExist(db, 'partners', id, 'Partner');
    const period = req.query.period ? z.string().regex(/^\d{4}-\d{2}$/).parse(req.query.period) : null;
    const { rows } = await db.query(
      `SELECT period, COUNT(DISTINCT job_id)::int AS jobs, SUM(basis_cents)::int AS basis_cents, SUM(share_cents)::int AS share_cents
         FROM payout_lines WHERE partner_id = $1 AND ($2::text IS NULL OR period = $2)
        GROUP BY period ORDER BY period DESC`,
      [id, period]);
    res.json(rows);
  });

  r.get('/tasks', async (req, res) => {
    const status = z.enum(['open', 'done']).default('open').parse(req.query.status);
    res.json((await db.query('SELECT * FROM tasks WHERE status = $1 ORDER BY due_at NULLS LAST, created_at', [status])).rows);
  });

  r.post('/tasks/:id/done', async (req, res) => {
    const id = idParam(req.params.id, 'Task');
    const { rows } = await db.query(`UPDATE tasks SET status = 'done' WHERE id = $1 RETURNING *`, [id]);
    if (!rows[0]) return res.status(404).json({ error: { code: 'not_found', message: 'Task not found' } });
    res.json(rows[0]);
  });

  return r;
}
