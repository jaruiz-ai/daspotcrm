/** Small RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes, BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

export const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** "$1,234.56", "1234.5", "(12.00)", "-12" → cents. null when not a number. */
export function parseMoney(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '').replace(/USD$/i, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -cents : cents;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, ene: 1, enero: 1,
  feb: 2, february: 2, febrero: 2,
  mar: 3, march: 3, marzo: 3,
  apr: 4, april: 4, abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, june: 6, junio: 6,
  jul: 7, july: 7, julio: 7,
  aug: 8, august: 8, ago: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, septiembre: 9, setiembre: 9,
  oct: 10, october: 10, octubre: 10,
  nov: 11, november: 11, noviembre: 11,
  dec: 12, december: 12, dic: 12, diciembre: 12,
};

export type DateOrder = 'mdy' | 'dmy';

/** A real calendar day as 'YYYY-MM-DD', or null (rejects Feb 30, month 13, and so on). */
function ymd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1980 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Two-digit years: up to next year's yy is 20yy, the rest 19yy ("24" → 2024, "98" → 1998). */
const fullYear = (yy: number) => {
  if (yy >= 100) return yy;
  const next = (new Date().getUTCFullYear() + 1) % 100;
  return yy <= next ? 2000 + yy : 1900 + yy;
};

/**
 * Calendar day from the formats spreadsheets export → 'YYYY-MM-DD'. Times are ignored.
 * Numeric dates like 04/05/2024 follow `order` (US month-first by default).
 * Handles: 3/15/2025, 03-15-25, 3.15.2025, 2025-03-15, 2025/3/15, March 15, 2025, Mar 15th 2025,
 * 15 March 2025, 15-Mar-2025, 15 de marzo de 2025, and Sheets/Excel serial numbers (45731).
 */
export function parseDay(raw: string | undefined, order: DateOrder = 'mdy'): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');
  if (!s) return null;
  let r: RegExpMatchArray | null;

  if ((r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[ t])/))) return ymd(+r[1], +r[2], +r[3]);

  if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|[ ,t])/))) {
    const [a, b, y] = [+r[1], +r[2], fullYear(+r[3])];
    return order === 'dmy' ? ymd(y, b, a) : ymd(y, a, b);
  }

  // Month name first: "march 15, 2025", "mar 15th 2025", "sept. 3 2024"
  if ((r = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/)) && MONTHS[r[1]]) return ymd(+r[3], MONTHS[r[1]], +r[2]);
  // Day first: "15 march 2025", "15-mar-2025", "15 de marzo de 2025"
  if ((r = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[ -](?:de )?([a-z]+)\.?,?[ -](?:de |del )?(\d{4}|\d{2})\b/)) && MONTHS[r[2]]) {
    return ymd(fullYear(+r[3]), MONTHS[r[2]], +r[1]);
  }

  // Spreadsheet serial day number (days since 1899-12-30), e.g. 45731 = 2025-03-15.
  if ((r = s.match(/^(\d{5})(?:\.\d+)?$/)) && +r[1] >= 29221 && +r[1] <= 73050) {
    return new Date(Date.UTC(1899, 11, 30) + +r[1] * 864e5).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Decides whether a column of numeric dates is month-first (US) or day-first.
 * A first number over 12 proves day-first; a second number over 12 proves month-first.
 * With no proof either way, US month-first is assumed and the dates are counted as ambiguous.
 */
export function detectDateOrder(values: string[]): { order: DateOrder; ambiguous: number; conflicting: boolean } {
  let dmy = 0, mdy = 0, ambiguous = 0;
  for (const v of values) {
    const r = v.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|[ ,tT])/);
    if (!r) continue;
    const a = +r[1], b = +r[2];
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
    else if (a <= 12 && b <= 12 && a !== b) ambiguous++;
  }
  return { order: dmy > mdy ? 'dmy' : 'mdy', ambiguous: dmy || mdy ? 0 : ambiguous, conflicting: dmy > 0 && mdy > 0 };
}

/** Adds months the way Postgres does: a day past the new month's end lands on its last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(d, last))).toISOString().slice(0, 10);
}

/**
 * Warranty length from a sheet: "Lifetime" → { months: null }, "5 years" → 60, "24 months" → 24,
 * "5 años" → 60. A bare number up to 15 is read as years, larger as months (noted for the preview).
 */
export function parseTerm(raw: string | undefined): { months: number | null; note?: string } | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (!s) return undefined;
  if (/^(lifetime|life|de por vida|vitalicia|permanent|forever)/.test(s)) return { months: null };
  let r = s.match(/^(\d{1,3})\s*(years?|yrs?|y|anos?)\b/);
  if (r) return { months: +r[1] * 12 };
  r = s.match(/^(\d{1,3})\s*(months?|mos?|m|meses?)\b/);
  if (r) return { months: +r[1] };
  r = s.match(/^(\d{1,3})$/);
  if (r) {
    const n = +r[1];
    return n <= 15 ? { months: n * 12, note: `Warranty "${raw}" read as ${n} years` } : { months: n, note: `Warranty "${raw}" read as ${n} months` };
  }
  return undefined;
}

export const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

/** Minutes after midnight from "3:04 PM", "15:04", or a date-time string. null when there is no time. */
export function parseMinutes(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
