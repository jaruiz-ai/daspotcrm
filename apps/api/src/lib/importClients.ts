import type { Queryable } from '../db/index.js';
import { addMonths, detectDateOrder, normHeader, parseCsv, parseDay, parseMoney, parseTerm, type DateOrder } from './csv.js';
import { badRequest } from './errors.js';
import { parseLead } from './leadParser.js';
import { toE164 } from './phone.js';
import { SHOP_TZ } from './warranty.js';

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
  install_date: ['date', 'install date', 'service date', 'date installed', 'installed', 'installed on', 'fecha', 'job date', 'date of service', 'install'],
  film: ['film', 'film type', 'product', 'tint type', 'film used', 'tint', 'material'],
  shade: ['shade', 'percent', 'vlt', 'tint percent', 'darkness', 'percentage'],
  service: ['service', 'services', 'work', 'job', 'work done', 'servicio'],
  price: ['price', 'total', 'amount', 'paid', 'cost', 'precio'],
  warranty_number: ['warranty', 'warranty number', 'warranty no', 'warranty id', 'warranty card', 'garantia', 'numero de garantia'],
  warranty_expires: ['warranty expires', 'expires', 'expiration', 'expiration date', 'expiry', 'exp date', 'exp', 'warranty end', 'warranty until', 'valid until', 'vence', 'vencimiento'],
  warranty_term: ['warranty term', 'term', 'warranty length', 'warranty years', 'coverage', 'warranty period', 'duracion'],
  notes: ['notes', 'note', 'comments', 'comment', 'notas'],
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
/** "Tint %" → "tint percent", "Warranty #" → "warranty number". */
const headerKey = (h: string) =>
  normHeader(fold(h).replace(/%/g, ' percent ').replace(/#/g, ' number ').replace(/\bno\./g, 'number')).replace(/\s+/g, ' ');

/** Guess which column holds which field. Exact header matches win over partial ones; each column is used once. */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const keys = headers.map(headerKey);
  const map: Partial<Record<ImportField, number>> = {};
  const used = new Set<number>();
  // Specific fields first so "Warranty Expires" isn't taken as a warranty number, "Tint %" as a film, etc.
  const order: ImportField[] = ['warranty_expires', 'warranty_term', 'warranty_number', 'shade', 'vin', 'email', 'phone',
    'first_name', 'last_name', 'full_name', 'install_date', 'plate', 'year', 'make', 'model', 'vehicle', 'film', 'service',
    'price', 'language', 'notes'];
  const hasWord = (k: string, w: string) => (` ${k} `).includes(` ${w} `);
  for (const pass of ['exact', 'partial'] as const) {
    for (const f of order) {
      if (map[f] != null) continue;
      const words = IMPORT_FIELDS[f] as readonly string[];
      const i = keys.findIndex((k, idx) => !used.has(idx) && k && (pass === 'exact'
        ? words.includes(k)
        : words.some((w) => w.length > 2 && hasWord(k, w))));
      if (i >= 0) { map[f] = i; used.add(i); }
    }
  }
  return map;
}

export interface ImportWarranty {
  number: string | null;          // null = assigned on import (DS-<job>-M1 style)
  coverage: 'manufacturer' | 'labor';
  film_line: string;
  starts_on: string;
  expires_on: string | null;      // null = lifetime
  source: 'sheet' | 'film';       // dates copied from the sheet, or worked out from the film's term
  in_term: boolean;
}

export interface ImportRowResult {
  line: number;
  name: string;
  phone: string | null;
  status: 'new' | 'existing' | 'skipped';
  vehicle: string | null;
  install_date: string | null;
  warranties: ImportWarranty[];
  notes: string[];
}

interface FilmProduct { id: string; brand: string; line: string; warranty_term_months: number | null; labor_warranty_months: number | null }

function matchFilm(raw: string, films: FilmProduct[]): FilmProduct | null {
  const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(raw);
  if (!t) return null;
  // Longest names first so "Nano Ceramic" beats "Ceramic" and "Carbon-Ceramic" beats "Carbon".
  const ranked = [...films].sort((a, b) => b.line.length - a.line.length);
  return ranked.find((f) => t === norm(f.line) || t === norm(`${f.brand} ${f.line}`))
    ?? ranked.find((f) => ` ${t} `.includes(` ${norm(f.line)} `))
    ?? null;
}

function splitName(full: string): [string | null, string | null] {
  const clean = full.trim().replace(/\s+/g, ' ');
  if (!clean) return [null, null];
  if (clean.includes(',')) { // "Ramirez, Sofia"
    const [last, first] = clean.split(',').map((s) => s.trim());
    return [first || null, last || null];
  }
  const parts = clean.split(' ');
  return [parts[0], parts.slice(1).join(' ') || null];
}

const SHADES = [5, 15, 20, 35, 40, 50, 70, 80];
const LIFETIME = /^(lifetime|life|never|de por vida|vitalicia|n\/?a|none)$/i;

/**
 * Imports past clients from a spreadsheet saved as CSV. With dryRun nothing is written and the result
 * is a preview; the real import writes exactly what the preview showed, including every warranty date.
 *
 * Warranty dates:
 * - start = the install date in the sheet (never the import day);
 * - end = the sheet's expiration date when it has one, else install date + the sheet's term,
 *   else install date + the film's term from the film list; "Lifetime" means no end date;
 * - the sheet's own warranty numbers are kept so customers' old cards still match.
 * Phone number is the identity: rows for a number already on file add to that customer.
 * Importing the same file twice does not duplicate past jobs or warranties.
 */
export async function importClients(
  q: Queryable,
  csv: string,
  opts: { dryRun: boolean; mapping?: Partial<Record<ImportField, number>>; dateOrder?: DateOrder },
) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('empty_file', 'The file needs a header row and at least one client.');
  if (rows.length > 5001) throw badRequest('too_many_rows', 'Import up to 5,000 clients at a time. Split the sheet into smaller files.');
  const headers = rows[0];
  const mapping = opts.mapping ?? guessMapping(headers);
  if (mapping.phone == null) throw badRequest('no_phone_column', 'Could not find a phone number column. Pick it in the column list and try again.');

  const col = (f: ImportField) => (mapping[f] != null ? rows.slice(1).map((r) => r[mapping[f]!] ?? '') : []);
  const detected = detectDateOrder([...col('install_date'), ...col('warranty_expires')]);
  const order: DateOrder = opts.dateOrder ?? detected.order;

  const films = (await q.query<FilmProduct>('SELECT id, brand, line, warranty_term_months, labor_warranty_months FROM film_products')).rows;
  const today = (await q.query<{ d: string }>(`SELECT ((now() AT TIME ZONE '${SHOP_TZ}')::date)::text AS d`)).rows[0].d;
  const takenNumbers = new Set((await q.query<{ number: string }>('SELECT upper(number) AS number FROM warranties')).rows.map((r) => r.number));

  const results: ImportRowResult[] = [];
  const unmatchedFilms = new Map<string, number>();
  const contactByPhone = new Map<string, string>(); // phone → contact id ('new' in a dry run)
  const counts = { rows: rows.length - 1, contacts_new: 0, contacts_existing: 0, vehicles: 0, past_jobs: 0, warranties: 0, skipped: 0 };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (f: ImportField) => (mapping[f] != null ? (r[mapping[f]!] ?? '').trim() : '');
    const notes: string[] = [];

    let first = get('first_name') || null;
    let last = get('last_name') || null;
    if (!first && !last && get('full_name')) [first, last] = splitName(get('full_name'));
    const phoneRaw = get('phone');
    const phone = toE164(phoneRaw);
    const result: ImportRowResult = {
      line: i + 1, name: [first, last].filter(Boolean).join(' ') || '(no name)', phone,
      status: 'skipped', vehicle: null, install_date: null, warranties: [], notes,
    };
    results.push(result);
    if (!phone) {
      notes.push(phoneRaw ? `"${phoneRaw}" is not a valid phone number` : 'No phone number');
      counts.skipped++;
      continue;
    }

    const emailRaw = get('email');
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw.toLowerCase() : null;
    if (emailRaw && !email) notes.push(`Email "${emailRaw}" left out`);
    const langRaw = fold(get('language'));
    const language = /^(es|sp|span|espanol)/.test(langRaw) ? 'es' : 'en';

    // ---- vehicle: separate columns, or one "2019 Toyota Tacoma" column
    let year: number | null = Number(get('year')) || null;
    let make = get('make') || null;
    let model = get('model') || null;
    const combined = get('vehicle');
    if (combined && !make && !model) {
      const p = parseLead(combined);
      year = year ?? p.year;
      make = p.make;
      model = p.model;
      if (!make) { // a make the parser doesn't know: "2019 Scion tC" → Scion / tC
        const rest = combined.replace(/\b(19|20)\d{2}\b/, '').trim().split(/\s+/);
        make = rest[0] || null;
        model = rest.slice(1).join(' ') || null;
      }
    }
    if (year != null && (year < 1950 || year > Number(today.slice(0, 4)) + 2)) { notes.push(`Year ${year} left out`); year = null; }
    const plate = get('plate').toUpperCase().slice(0, 10) || null;
    const vinRaw = get('vin').toUpperCase().replace(/\s/g, '');
    const vin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw) ? vinRaw : null;
    if (vinRaw && !vin) notes.push(`VIN "${get('vin')}" is not 17 valid characters, left out`);
    const hasVehicle = !!(year || make || model || plate || vin);
    if (hasVehicle) result.vehicle = [year, make, model].filter(Boolean).join(' ') || plate || vin;

    // ---- install date and warranty dates
    const dateRaw = get('install_date');
    let installDay = parseDay(dateRaw, order);
    if (dateRaw && !installDay) notes.push(`Install date "${dateRaw}" not understood, so no past job or warranty was added`);
    if (installDay && installDay > today) { notes.push(`Install date ${installDay} is in the future, so no past job was added`); installDay = null; }
    result.install_date = installDay;

    const filmRaw = get('film');
    const film = filmRaw ? matchFilm(filmRaw, films) : null;
    if (filmRaw && !film) unmatchedFilms.set(filmRaw, (unmatchedFilms.get(filmRaw) ?? 0) + 1);

    const numberRaw = get('warranty_number').toUpperCase().replace(/\s+/g, '');
    const expiresRaw = get('warranty_expires');
    const termRaw = get('warranty_term');
    const sheetHasWarranty = !!(numberRaw || expiresRaw || termRaw);

    if (installDay) {
      if (sheetHasWarranty) {
        // The shop's own warranty record: copy its dates and number.
        let expires: string | null | undefined;
        if (expiresRaw) {
          if (LIFETIME.test(expiresRaw)) expires = null;
          else {
            expires = parseDay(expiresRaw, order) ?? undefined;
            if (expires === undefined) notes.push(`Warranty end "${expiresRaw}" not understood`);
          }
        }
        if (expires === undefined) {
          const term = parseTerm(termRaw);
          if (term) {
            expires = term.months == null ? null : addMonths(installDay, term.months);
            if (term.note) notes.push(term.note);
          } else if (termRaw) notes.push(`Warranty length "${termRaw}" not understood`);
        }
        if (expires === undefined && film) expires = film.warranty_term_months == null ? null : addMonths(installDay, film.warranty_term_months);
        if (expires === undefined) {
          notes.push('Warranty has no end date, length or known film, so it was not added. Fix the row and import again.');
        } else if (expires !== null && expires < installDay) {
          notes.push(`Warranty end ${expires} is before the install date ${installDay}, so it was not added`);
        } else {
          let number: string | null = numberRaw || null;
          if (number && (number.length > 40 || takenNumbers.has(number))) {
            notes.push(takenNumbers.has(number) ? `Warranty number ${number} is already used, so a new number is assigned` : 'Warranty number too long, a new number is assigned');
            number = null;
          }
          if (number) takenNumbers.add(number);
          result.warranties.push({
            number, coverage: 'manufacturer', film_line: film?.line ?? (filmRaw || 'Window film'),
            starts_on: installDay, expires_on: expires, source: 'sheet', in_term: expires == null || expires >= today,
          });
        }
      } else if (film) {
        // No warranty info in the sheet: the film's standard warranty, like a job done in the CRM.
        const mfr = film.warranty_term_months == null ? null : addMonths(installDay, film.warranty_term_months);
        result.warranties.push({ number: null, coverage: 'manufacturer', film_line: film.line, starts_on: installDay,
          expires_on: mfr, source: 'film', in_term: mfr == null || mfr >= today });
        if (film.labor_warranty_months) {
          const lab = addMonths(installDay, film.labor_warranty_months);
          result.warranties.push({ number: null, coverage: 'labor', film_line: 'Installation', starts_on: installDay,
            expires_on: lab, source: 'film', in_term: lab >= today });
        }
      } else if (filmRaw) {
        notes.push(`Film "${filmRaw}" isn't in your film list and the sheet has no warranty dates, so no warranty`);
      }
    } else if (sheetHasWarranty && !dateRaw) {
      notes.push('Warranty needs an install date, so it was not added');
    }

    const shadeNum = Number((get('shade').match(/\d{1,2}/) ?? [])[0]);
    const shade = SHADES.includes(shadeNum) ? shadeNum : null;
    const serviceText = get('service');
    const service = serviceText ? parseLead(serviceText).services[0] ?? 'other' : 'full_tint';
    const price = parseMoney(get('price'));
    const noteText = get('notes');

    // ---- contact
    const known = contactByPhone.get(phone);
    const existing = known ? null : (await q.query('SELECT id FROM contacts WHERE mobile = $1', [phone])).rows[0];
    result.status = known || existing ? 'existing' : 'new';
    if (!known) { if (existing) counts.contacts_existing++; else counts.contacts_new++; }

    if (opts.dryRun) {
      contactByPhone.set(phone, known ?? existing?.id ?? 'new');
      if (hasVehicle) counts.vehicles++;
      if (installDay) counts.past_jobs++;
      counts.warranties += result.warranties.length;
      continue;
    }

    let contactId = known ?? existing?.id;
    if (!contactId) {
      contactId = (await q.query(
        `INSERT INTO contacts (first_name, last_name, mobile, email, language, lead_source, tags)
         VALUES ($1,$2,$3,$4,$5,'import','{imported}') RETURNING id`,
        [first, last, phone, email, language])).rows[0].id as string;
    } else {
      // Fill blanks only; never overwrite what staff already have.
      await q.query(
        `UPDATE contacts SET first_name = COALESCE(first_name, $2), last_name = COALESCE(last_name, $3),
                email = COALESCE(email, $4), updated_at = now() WHERE id = $1`,
        [contactId, first, last, email]);
    }
    contactByPhone.set(phone, contactId!);

    // ---- vehicle
    let vehicleId: string | null = null;
    if (hasVehicle) {
      const same = (await q.query(
        `SELECT id FROM vehicles WHERE contact_id = $1 AND (
            ($2::text IS NOT NULL AND vin = $2) OR ($3::text IS NOT NULL AND upper(replace(plate,' ','')) = replace($3,' ',''))
            OR ((lower(coalesce(make,'')) = lower(coalesce($4,'')) AND lower(coalesce(model,'')) = lower(coalesce($5,''))
                AND (year IS NOT DISTINCT FROM $6 OR $6::int IS NULL)) AND ($4::text IS NOT NULL OR $5::text IS NOT NULL)))
          LIMIT 1`,
        [contactId, vin, plate, make, model, year])).rows[0];
      vehicleId = same?.id ?? (await q.query(
        `INSERT INTO vehicles (contact_id, year, make, model, plate, vin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [contactId, year, make, model, plate, vin])).rows[0].id;
      if (!same) counts.vehicles++;
    }

    // ---- past job and its warranties
    if (installDay) {
      const dup = (await q.query(
        `SELECT id FROM jobs WHERE contact_id = $1 AND lead_source = 'import' AND vehicle_id IS NOT DISTINCT FROM $2
            AND ((completed_at AT TIME ZONE '${SHOP_TZ}')::date) = $3::date LIMIT 1`,
        [contactId, vehicleId, installDay])).rows[0];
      if (dup) {
        notes.push('Already imported, skipped this time');
        result.warranties = [];
        continue;
      }
      // Dated to the install day (noon, shop time) so old jobs don't crowd the Paid column.
      const at = `(($3::date + time '12:00') AT TIME ZONE '${SHOP_TZ}')`;
      const job = (await q.query(
        `INSERT INTO jobs (contact_id, vehicle_id, stage, lead_source, completed_at, created_at, updated_at, tax_rate_bp)
         VALUES ($1, $2, 'paid', 'import', ${at}, ${at}, ${at}, 0) RETURNING id, number`,
        [contactId, vehicleId, installDay])).rows[0];
      await q.query(
        `INSERT INTO job_line_items (job_id, service, shade_vlt, film_product_id, unit_price_cents, description)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [job.id, service, shade, film?.id ?? null, Math.max(0, Math.min(price ?? 0, 10_000_000)), filmRaw && !film ? `Film: ${filmRaw}` : null]);
      await q.query(`INSERT INTO notes (subject_type, subject_id, type, body) VALUES ('job', $1, 'internal', $2)`,
        [job.id, ['Imported from spreadsheet.', noteText].filter(Boolean).join(' ')]);
      counts.past_jobs++;

      // Exactly the dates shown in the preview: no recalculation here.
      const fresh = (base: string) => {
        let n = 1;
        while (takenNumbers.has(`${base}${n}`)) n++;
        takenNumbers.add(`${base}${n}`);
        return `${base}${n}`;
      };
      for (const w of result.warranties) {
        const number = w.number ?? fresh(w.coverage === 'labor' ? `DS-${job.number}-L` : `DS-${job.number}-M`);
        await q.query(
          `INSERT INTO warranties (number, job_id, contact_id, vehicle_id, coverage, film_brand, film_line, windows_covered, starts_on, expires_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'{}',$8::date,$9::date)`,
          [number, job.id, contactId, vehicleId, w.coverage, w.coverage === 'labor' ? 'Da Spot 214' : film?.brand ?? null,
           w.film_line, w.starts_on, w.expires_on]);
        w.number = number;
        counts.warranties++;
      }
    } else if (noteText) {
      await q.query(`INSERT INTO notes (subject_type, subject_id, type, body) VALUES ('contact', $1, 'internal', $2)`,
        [contactId, `Imported: ${noteText}`]);
    }
  }

  return {
    headers,
    mapping,
    date_order: { order, detected: detected.order, ambiguous: detected.ambiguous, conflicting: detected.conflicting },
    counts,
    unmatched_films: [...unmatchedFilms.entries()].map(([film, n]) => ({ film, rows: n })),
    rows: results.slice(0, 1000),
  };
}
