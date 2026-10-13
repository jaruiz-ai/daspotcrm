import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { IMPORT_FIELDS, importClients, type ImportField } from '../lib/importClients.js';

const fields = Object.keys(IMPORT_FIELDS) as [ImportField, ...ImportField[]];

export function importsRouter({ db }: Deps) {
  const r = Router();

  /**
   * Past-client import from a spreadsheet saved as CSV.
   * dry_run: true returns a preview and writes nothing. The real import is all-or-nothing.
   */
  r.post('/import/clients', async (req, res) => {
    const b = z.object({
      csv: z.string().min(1).max(3_000_000),
      dry_run: z.boolean().default(true),
      mapping: z.partialRecord(z.enum(fields), z.number().int().min(0).max(200)).optional(),
    }).parse(req.body);
    const out = b.dry_run
      ? await importClients(db, b.csv, { dryRun: true, mapping: b.mapping })
      : await db.tx((q) => importClients(q, b.csv, { dryRun: false, mapping: b.mapping }));
    res.json({ ...out, dry_run: b.dry_run, fields: Object.keys(IMPORT_FIELDS) });
  });

  return r;
}
