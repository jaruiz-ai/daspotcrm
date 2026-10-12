/**
 * Pulls vehicle, service and shade out of a customer's first text, e.g.
 * "hey how much for 20% on a 2022 camry all windows" or
 * "cuanto por polarizar mi silverado 2019 al 15".
 * Rule-based so it works offline and in tests; an LLM pass can replace it later
 * behind the same return type.
 */
export interface ParsedLead {
  language: 'en' | 'es';
  year: number | null;
  make: string | null;
  model: string | null;
  services: string[];
  shade_vlt: number | null;
}

const MODEL_TO_MAKE: Record<string, [string, string]> = {
  camry: ['Toyota', 'Camry'], corolla: ['Toyota', 'Corolla'], tacoma: ['Toyota', 'Tacoma'], tundra: ['Toyota', 'Tundra'],
  rav4: ['Toyota', 'RAV4'], '4runner': ['Toyota', '4Runner'], highlander: ['Toyota', 'Highlander'],
  civic: ['Honda', 'Civic'], accord: ['Honda', 'Accord'], 'cr-v': ['Honda', 'CR-V'], crv: ['Honda', 'CR-V'],
  altima: ['Nissan', 'Altima'], sentra: ['Nissan', 'Sentra'], maxima: ['Nissan', 'Maxima'],
  'f-150': ['Ford', 'F-150'], f150: ['Ford', 'F-150'], mustang: ['Ford', 'Mustang'], explorer: ['Ford', 'Explorer'],
  bronco: ['Ford', 'Bronco'], silverado: ['Chevrolet', 'Silverado'], tahoe: ['Chevrolet', 'Tahoe'],
  camaro: ['Chevrolet', 'Camaro'], malibu: ['Chevrolet', 'Malibu'], sierra: ['GMC', 'Sierra'], yukon: ['GMC', 'Yukon'],
  ram: ['Ram', '1500'], charger: ['Dodge', 'Charger'], challenger: ['Dodge', 'Challenger'], durango: ['Dodge', 'Durango'],
  wrangler: ['Jeep', 'Wrangler'], 'grand cherokee': ['Jeep', 'Grand Cherokee'],
  'model 3': ['Tesla', 'Model 3'], 'model y': ['Tesla', 'Model Y'], 'model s': ['Tesla', 'Model S'], 'model x': ['Tesla', 'Model X'],
  elantra: ['Hyundai', 'Elantra'], sonata: ['Hyundai', 'Sonata'], tucson: ['Hyundai', 'Tucson'],
  optima: ['Kia', 'Optima'], k5: ['Kia', 'K5'], telluride: ['Kia', 'Telluride'],
};
const MAKES = ['toyota', 'honda', 'nissan', 'ford', 'chevrolet', 'chevy', 'gmc', 'ram', 'dodge', 'jeep', 'tesla', 'hyundai',
  'kia', 'bmw', 'mercedes', 'audi', 'lexus', 'infiniti', 'acura', 'cadillac', 'subaru', 'mazda', 'volkswagen', 'vw'];
const MAKE_DISPLAY: Record<string, string> = { chevy: 'Chevrolet', vw: 'Volkswagen', bmw: 'BMW', gmc: 'GMC' };

const SPANISH_HINTS = /\b(hola|cu[aá]nto|cuesta|precio|polarizad[oa]|polarizar|vidrios|ventanas|mi (carro|troca|camioneta)|quiero|gracias|buenas|tienen|cita|todo el carro)\b/i;

const SERVICE_PATTERNS: [RegExp, string][] = [
  [/\b(remove|removal|quitar|purple|bubbl\w*|old tint)\b/i, 'removal'],
  [/\b(windshield|parabrisas)\b/i, 'windshield'],
  [/\b(sun ?strip|visor|eyebrow)\b/i, 'sun_strip'],
  [/\b(pano(ramic)?|sunroof|moonroof|roof)\b/i, 'pano_roof'],
  [/\b(front two|front 2|2 fronts|fronts?|front windows|delanteras?)\b/i, 'front_two'],
  [/\b(full|all (the )?windows|whole car|todo el carro|todas)\b/i, 'full_tint'],
  [/\b(wrap|vinyl|color change)\b/i, 'wrap'],
  [/\b(chrome delete|blackout trim|black ?out)\b/i, 'chrome_delete'],
  [/\b(headlights?|tail ?lights?|luces|calaveras)\b/i, 'lights'],
  [/\b(house|home|storefront|office|casa|negocio|building)\b/i, 'flat_glass'],
];
const VALID_SHADES = [5, 15, 20, 35, 40, 50, 70, 80];

export function parseLead(text: string, now = new Date()): ParsedLead {
  const t = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  const language: 'en' | 'es' = SPANISH_HINTS.test(t) ? 'es' : 'en';

  // Year: 4-digit 1980..next year, or 2-digit after an apostrophe ("'19").
  let year: number | null = null;
  const maxYear = now.getFullYear() + 1;
  for (const m of t.matchAll(/(?:^|[^\d%])((?:19|20)\d{2})(?![\d%])/g)) {
    const y = Number(m[1]);
    if (y >= 1980 && y <= maxYear) { year = y; break; }
  }
  if (year == null) {
    const m = t.match(/'(\d{2})\b/);
    if (m) {
      const y2 = Number(m[1]);
      const y = y2 + (y2 <= maxYear % 100 ? 2000 : 1900);
      if (y >= 1980) year = y;
    }
  }

  let make: string | null = null;
  let model: string | null = null;
  // Longest model keys first so "grand cherokee" wins over shorter tokens.
  const modelKeys = Object.keys(MODEL_TO_MAKE).sort((a, b) => b.length - a.length);
  for (const k of modelKeys) {
    const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[-]/g, '[- ]?').replace(/ /g, ' ')}($|[^a-z0-9])`);
    if (re.test(t)) { [make, model] = MODEL_TO_MAKE[k]; break; }
  }
  if (!make) {
    for (const mk of MAKES) {
      if (new RegExp(`(^|[^a-z])${mk}($|[^a-z])`).test(t)) {
        make = MAKE_DISPLAY[mk] ?? mk.charAt(0).toUpperCase() + mk.slice(1);
        break;
      }
    }
  }

  const services: string[] = [];
  for (const [re, s] of SERVICE_PATTERNS) if (re.test(t) && !services.includes(s)) services.push(s);
  if (services.includes('full_tint')) {
    const i = services.indexOf('front_two');
    if (i >= 0) services.splice(i, 1);
  }

  // Shade: "20%", "20 percent", "al 15", "15s". Ignore numbers that are the year.
  let shade_vlt: number | null = null;
  const shadeMatch = t.match(/\b(\d{1,2})\s?(%|percent|por ?ciento|s\b)/) ?? t.match(/\bal (\d{1,2})\b/);
  if (shadeMatch) {
    const v = Number(shadeMatch[1]);
    if (VALID_SHADES.includes(v)) shade_vlt = v;
  }

  return { language, year, make, model, services, shade_vlt };
}
