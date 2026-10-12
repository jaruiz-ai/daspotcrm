import type { Db } from './index.js';

/**
 * Placeholder price-book data. Brands and warranty terms here are examples —
 * replace them in Settings with the films the shop actually carries.
 */
export async function seed(db: Db) {
  const has = await db.query('SELECT 1 FROM film_products LIMIT 1');
  if (has.rows[0]) return;
  await db.exec(`
    INSERT INTO film_products (brand, line, tier, cost_per_ft_cents, warranty_term_months, labor_warranty_months) VALUES
      ('House', 'Carbon', 'carbon', 150, 60, 12),
      ('House', 'Carbon-Ceramic', 'carbon-ceramic', 250, NULL, 12),
      ('House', 'Nano Ceramic', 'nano-ceramic', 400, NULL, 24),
      ('House', 'Architectural', 'architectural', 300, 120, 12);
    INSERT INTO users (name, email, role) VALUES
      ('Owner', 'owner@example.com', 'owner'),
      ('Front desk', 'desk@example.com', 'desk'),
      ('Installer', 'installer@example.com', 'installer');
  `);
}
