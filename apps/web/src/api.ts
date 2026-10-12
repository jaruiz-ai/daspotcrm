const TOKEN_KEY = 'daspot.staffToken';

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
};
export const setToken = (t: string) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${getToken()}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) setToken('');
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const money = (cents: number | null | undefined) =>
  (Number(cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const STAGES = [
  { key: 'new_lead', label: 'New lead', shade: 70 },
  { key: 'quoted', label: 'Quoted', shade: 50 },
  { key: 'booked', label: 'Booked', shade: 35 },
  { key: 'in_bay', label: 'In the bay', shade: 20 },
  { key: 'completed', label: 'Completed', shade: 15 },
  { key: 'paid', label: 'Paid', shade: 5 },
] as const;

export const SERVICES: Record<string, string> = {
  full_tint: 'Full tint', front_two: 'Front two', windshield: 'Windshield', sun_strip: 'Sun strip',
  pano_roof: 'Panoramic roof', removal: 'Old film removal', wrap: 'Wrap', chrome_delete: 'Chrome delete',
  lights: 'Lights', flat_glass: 'Home / storefront', other: 'Other',
};

export const vehicleName = (j: { year?: number | null; make?: string | null; model?: string | null;
  vehicle_year?: number | null; vehicle_make?: string | null; vehicle_model?: string | null }) =>
  [j.year ?? j.vehicle_year, j.make ?? j.vehicle_make, j.model ?? j.vehicle_model].filter(Boolean).join(' ');

export const personName = (c: { first_name?: string | null; last_name?: string | null; mobile?: string }) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || formatPhone(c.mobile ?? '');

export const formatPhone = (e164: string) => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
};
