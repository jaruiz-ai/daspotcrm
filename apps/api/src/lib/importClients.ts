import type { Queryable } from '../db/index.js';
import { normHeader, parseCsv, parseDay, parseMoney } from './csv.js';
import { badRequest } from './errors.js';
import { parseLead } from './leadParser.js';
import { toE164 } from './phone.js';
import { issueWarranties, SHOP_TZ } from './warranty.js';

/** Fields a past-client spreadsheet can fill, and the header words that point to each. */
export const IMPORT_FIELDS = {
  full_name: ['name', 'customer', 'client', 'customer name', 'client name', 'full name', 'nombre', 'cliente'],
  first_name: ['first name', 'first', 'firstname', 'given name'],
  last_name: ['last name', 'last', 'lastname', 'surname', 'apellido'],
  phone: ['phone', 'mobile', 'cell', 'phone number', 'cell phone', 'mobile number', 'number', 'telefono', 'tel', 'celular'],
  email: ['email', 'e mail', 'email address', 'correo'],
  language: ['language', 'idioma', 'lang'],
  vehicle: ['vehicle', 'car', 'auto', 'carro', 'vehiculo', 'year make model', 'ymm'],
  year: ['year', 'yr', 'ano', 'model year'],
  make: ['make', 'brand', 'marca'],
  model: ['model', 'modelo'],
  plate: ['plate', 'license plate', 'license', 'tag', 'placa', 'plates'],
  vin: ['vin', 'vin number'],
  install_date: ['date', 'install date', 'service date', 'date installed', 'installed', 'fecha', 'job date', 'date of service'],
  film: ['film', 'film type', 'product', 'tint type', 'film used', 'tint', 'material'],
  shade: ['shade', 'percent', 'vlt', 'tint percent', 'darkness', 'tint %', '%'],
  service: ['service', 'services', 'work', 'job', 'work done', 'servicio'],
  price: ['price', 'total', 'amount', 'paid', 'cost', 'precio'],
  notes: ['notes', 'note', 'comments', 'comment', 'notas'],
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const headerKey = (h: string) => normHeader(fold(h)).replace(/\s+/g, ' ');

/** Guess which column holds which field. Exact header matches win over partial ones; each column is used once. */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const keys = headers.map((h) => headerKey(h) || (h.includes('%') ? '%' : ''));
  const map: Partial<Record<ImportField, number>> = {};
  const used = new Set<number>();
  const order: ImportField[] = ['shade', 'vin', 'email', 'phone', 'first_name', 'last_name', 'full_name', 'install_date',
    'plate', 'year', 'make', 'model', 'vehicle', 'film', 'service', 'price', 'language', 'notes'];
  for (const pass of ['exact', 'partial'] as const) {
    for (const f of order) {
      if (map[f] != null) continue;
      const words = IMPORT_FIELDS[f] as readonly string[];
      const i = keys.findIndex((k, idx) => !used.has(idx) && k && (pass === 'exact'
        ? words.includes(k)
        : words.some((w) => w.length > 2 && (` ${k} `).includes(` ${w} `))));
      if (i >= 0) { map[f] = i; used.add(i); }
    }
  }
  // "Tint %" style headers: a % sign means shade even when the words say tint.
  const pct = headers.findIndex((h, i) => h.includes('%') && !used.has(i));
  if (map.shade == null && pct >= 0) map.shade = pct;
  return map;
}

export interface ImportRowResult {
  line: number;
  name: string;
  phone: string | null;
  status: 'new' | 'existing' | 'skipped';
  vehicle: string | null;
  past_job: boolean;
  warranty: boolean;
  notes: string[];
}

export interface FilmProduct { id: string; brand: string; line: string }

function matchFilm(raw: string, films: FilmProduct[]): FilmProduct | null {
  const t = fold(raw).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return null;
  const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
  // Longest names first so "Nano Ceramic" beats "Ceramic" and "Carbon-Ceramic" beats "Carbon".
  const ranked = [...films].sort((a, b) => b.line.length - a.line.length);
  return ranked.find((f) => t === norm(f.line) || t === norm(`${f.brand} ${f.line}`))
    ?? ranked.find((f) => ` ${t} `.includes(` ${norm(f.line)} `))
    ?? null;
}

function splitName(full: string): [string | null, string | null] {
  const parts = full.trim().replace(/\s+/g, ' ').split(' ');
  if (!parts[0]) return [null, null];
  if (full.includes(',')) { // "Ramirez, Sofia"
    const [last, first] = full.split(',').map((s) => s.trim());
    return [first || null, last || null];
  }
  return [parts[0], parts.slice(1).join(' ') || null];
}

const SHADES = [5, 15, 20, 35, 40, 50, 70, 80];

/**
 * Imports past clients. With dryRun, nothing is written and the result is a preview.
 * Phone number is the identity: rows for a number already on file add to that customer
 * and only fill fields that are blank. A past job (and its warranty, when the film is in the
 * film list) is created when the row has an install date; importing the same file twice
 * does not duplicate those jobs.
 */
export async function importClients(
  q: Queryable,
  csv: string,
  opts: { dryRun: boolean; mapping?: Partial<Record<ImportField, number>> },
) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('empty_file', 'The file needs a header row and at least one client.');
  if (rows.length > 5001) throw badRequest('too_many_rows', 'Import up to 5,000 clients at a time. Split the sheet into smaller files.');
  const headers = rows[0];
  const mapping = opts.mapping ?? guessMapping(headers);
  if (mapping.phone == null) throw badRequest('no_phone_column', 'Could not find a phone number column. Pick it in the column list and try again.');

  const films = (await q.query<FilmProduct>('SELECT id, brand, line FROM film_products')).rows;
  const today = (await q.query<{ d: string }>(`SELECT ((now() AT TIME ZONE '${SHOP_TZ}')::date)::text AS d`)).rows[0].d;

  const results: ImportRowResult[] = [];
  const unmatchedFilms = new Map<string, number>();
  const seenInFile = new Map<string, string>(); // phone → contact id (or 'new' in dry run)
  const counts = { rows: rows.length - 1, contacts_new: 0, contacts_existing: 0, vehicles: 0, past_jobs: 0, warranties: 0, skipped: 0 };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const get = (f: ImportField) => (mapping[f] != null ? (r[mapping[f]!] ?? '').trim() : '');
    const notes: string[] = [];

    let first = get('first_name') || null;
    let last = get('last_name') || null;
    if (!first && !last && get('full_name')) [first, last] = splitName(get('full_name'));
    const name = [first, last].filter(Boolean).join(' ') || '(no name)';
    const phoneRaw = get('phone');
    const phone = toE164(phoneRaw);
    const result: ImportRowResult = { line, name, phone, status: 'skipped', vehicle: null, past_job: false, warranty: false, notes };
    results.push(result);
    if (!phone) {
      notes.push(phoneRaw ? `"${phoneRaw}" is not a valid phone number` : 'No phone number');
      counts.skipped++;
      continue;
    }

    const emailRaw = get('email');
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw.toLowerCase() : null;
    if (emailRaw && !email) notes.push(`Email "${emailRaw}" ignored`);
    const langRaw = fold(get('language'));
    const language = /^(es|sp|span|espanol)/.test(langRaw) ? 'es' : langRaw ? 'en' : null;

    // Vehicle: separate columns, or one "2019 Toyota Tacoma" column.
    let year: number | null = Number(get('year')) || null;
    let make = get('make') || null;
    let model = get('model') || null;
    const combined = get('vehicle');
    if (combined && !make && !model) {
      const p = parseLead(combined);
      year = year ?? p.year;
      make = p.make;
      model = p.model;
      if (!make) { // unknown make: "2019 Scion tC" → Scion / tC
        const rest = combined.replace(/\b(19|20)\d{2}\b/, '').trim().split(/\s+/);
        make = rest[0] || null;
        model = rest.slice(1).join(' ') || null;
      }
    }
    if (year != null && (year < 1950 || year > Number(today.slice(0, 4)) + 2)) { notes.push(`Year ${year} ignored`); year = null; }
    const plate = get('plate').toUpperCase().slice(0, 10) || null;
    const vinRaw = get('vin').toUpperCase().replace(/\s/g, '');
    const vin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw) ? vinRaw : null;
    if (vinRaw && !vin) notes.push(`VIN "${get('vin')}" is not 17 valid characters, left out`);
    const hasVehicle = !!(year || make || model || plate || vin);
    if (hasVehicle) result.vehicle = [year, make, model].filter(Boolean).join(' ') || plate || vin;

    const dateRaw = get('install_date');
    let installDay = parseDay(dateRaw);
    if (dateRaw && !installDay) notes.push(`Date "${dateRaw}" not understood, so no past job was added`);
    if (installDay && installDay > today) { notes.push(`Date ${installDay} is in the future, so no past job was added`); installDay = null; }
    const filmRaw = get('film');
    const film = filmRaw ? matchFilm(filmRaw, films) : null;
    if (filmRaw && !film) unmatchedFilms.set(filmRaw, (unmatchedFilms.get(filmRaw) ?? 0) + 1);
    const shadeNum = Number((get('shade').match(/\d{1,2}/) ?? [])[0]);
    const shade = SHADES.includes(shadeNum) ? shadeNum : null;
    const serviceText = get('service');
    const service = serviceText ? parseLead(serviceText).services[0] ?? 'other' : 'full_tint';
    const price = parseMoney(get('price'));
    const noteText = get('notes');

    // ---------- contact ----------
    const existing = (await q.query('SELECT * FROM contacts WHERE mobile = $1', [phone])).rows[0];
    const fileContact = seenInFile.get(phone);
    result.status = existing || fileContact ? 'existing' : 'new';
    if (existing || fileContact) counts.contacts_existing += existing && !fileContact ? 1 : 0;
    else counts.contacts_new++;

    if (opts.dryRun) {
      seenInFile.set(phone, existing?.id ?? 'new');
      if (hasVehicle) counts.vehicles++;
      if (installDay) {
        result.past_job = true; counts.past_jobs++;
        if (film) { result.warranty = true; counts.warranties++; }
        else if (filmRaw) notes.push(`Film "${filmRaw}" isn't in your film list, so no warranty`);
      }
      continue;
    }

    let contactId: string = existing?.id ?? fileContact;
    if (!contactId) {
      contactId = (await q.query(
        `INSERT INTO contacts (first_name, last_name, mobile, email, language, lead_source, tags)
         VALUES ($1,$2,$3,$4,$5,'import','{imported}') RETURNING id`,
        [first, last, phone, email, language ?? 'en'])).rows[0].id;
    } else {
      // Fill blanks only; never overwrite what staff already have.
      await q.query(
        `UPDATE contacts SET first_name = COALESCE(first_name, $2), last_name = COALESCE(last_name, $3),
                email = COALESCE(email, $4), updated_at = now() WHERE id = $1`,
        [contactId, first, last, email]);
    }
    seenInFile.set(phone, contactId);

    // ---------- vehicle ----------
    let vehicleId: string | null = null;
    if (hasVehicle) {
      const same = (await q.query(
        `SELECT id FROM vehicles WHERE contact_id = $1 AND (
            ($2::text IS NOT NULL AND vin = $2) OR ($3::text IS NOT NULL AND upper(replace(plate,' ','')) = replace($3,' ',''))
            OR (lower(coalesce(make,'')) = lower(coalesce($4,'')) AND lower(coalesce(model,'')) = lower(coalesce($5,''))
                AND (year IS NOT DISTINCT FROM $6 OR $6::int IS NULL) AND ($4::text IS NOT NULL OR $5::text IS NOT NULL)))
          LIMIT 1`,
        [contactId, vin, plate, make, model, year])).rows[0];
      vehicleId = same?.id ?? (await q.query(
        `INSERT INTO vehicles (contact_id, year, make, model, plate, vin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [contactId, year, make, model, plate, vin])).rows[0].id;
      if (!same) counts.vehicles++;
    }

    // ---------- past job + warranty ----------
    if (installDay) {
      const completedAt = `${installDay} 12:00`;
      const dup = (await q.query(
        `SELECT id FROM jobs WHERE contact_id = $1 AND lead_source = 'import' AND vehicle_id IS NOT DISTINCT FROM $2
            AND ((completed_at AT TIME ZONE '${SHOP_TZ}')::date) = $3::date LIMIT 1`,
        [contactId, vehicleId, installDay])).rows[0];
      if (dup) {
        notes.push('Past job already imported');
      } else {
        const job = (await q.query(
          // Dated to the install day so old jobs don't crowd the Paid column on the board.
          `INSERT INTO jobs (contact_id, vehicle_id, stage, lead_source, completed_at, created_at, updated_at, tax_rate_bp)
           VALUES ($1,$2,'paid','import', ($3::timestamp AT TIME ZONE '${SHOP_TZ}'),
                   ($3::timestamp AT TIME ZONE '${SHOP_TZ}'), ($3::timestamp AT TIME ZONE '${SHOP_TZ}'), 0) RETURNING id`,
          [contactId, vehicleId, completedAt])).rows[0];
        await q.query(
          `INSERT INTO job_line_items (job_id, service, shade_vlt, film_product_id, unit_price_cents, description)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [job.id, service, shade, film?.id ?? null, Math.max(0, price ?? 0), filmRaw && !film ? `Film: ${filmRaw}` : null]);
        const memo = ['Imported from spreadsheet.', noteText].filter(Boolean).join(' ');
        await q.query(`INSERT INTO notes (subject_type, subject_id, type, body) VALUES ('job', $1, 'internal', $2)`, [job.id, memo]);
        result.past_job = true; counts.past_jobs++;
        if (film) {
          const n = await issueWarranties(q, job.id);
          if (n > 0) { result.warranty = true; counts.warranties++; }
        } else if (filmRaw) notes.push(`Film "${filmRaw}" isn't in your film list, so no warranty`);
      }
    } else if (noteText) {
      await q.query(`INSERT INTO notes (subject_type, subject_id, type, body) VALUES ('contact', $1, 'internal', $2)`,
        [contactId, `Imported: ${noteText}`]);
    }
  }

  return {
    headers,
    mapping,
    counts,
    unmatched_films: [...unmatchedFilms.entries()].map(([film, rows]) => ({ film, rows })),
    rows: results.slice(0, 500),
  };
}
