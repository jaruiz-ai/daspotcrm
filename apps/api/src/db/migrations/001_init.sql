-- Da Spot 214 CRM — Phase 1 schema
-- Money is stored in integer cents. Phone numbers in E.164.
-- Requires Postgres 13+ (gen_random_uuid is built in).


CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  role        text NOT NULL CHECK (role IN ('owner','desk','installer','partner')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  type            text NOT NULL DEFAULT 'other' CHECK (type IN ('dealer','fleet','storefront','other')),
  phone           text,
  billing_email   text,
  net_terms_days  int CHECK (net_terms_days IS NULL OR net_terms_days >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    text,
  last_name     text,
  mobile        text NOT NULL UNIQUE CHECK (mobile ~ '^\+[1-9][0-9]{7,14}$'),
  email         text,
  language      text NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
  preferred_channel text NOT NULL DEFAULT 'sms' CHECK (preferred_channel IN ('sms','whatsapp')),
  ig_handle     text,
  lead_source   text,
  tags          text[] NOT NULL DEFAULT '{}',
  sms_opt_in    boolean NOT NULL DEFAULT true,
  company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  year          int CHECK (year IS NULL OR (year BETWEEN 1950 AND 2100)),
  make          text,
  model         text,
  trim          text,
  body_type     text CHECK (body_type IS NULL OR body_type IN ('sedan','coupe','suv','truck','van','other')),
  color         text,
  plate         text,
  vin           text CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  has_pano_roof boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_contact_idx ON vehicles(contact_id);
CREATE INDEX vehicles_plate_idx ON vehicles(upper(plate));

CREATE TABLE properties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
  address       text NOT NULL,
  city          text,
  zip           text,
  type          text NOT NULL CHECK (type IN ('residential','commercial')),
  window_count  int CHECK (window_count IS NULL OR window_count >= 0),
  glass_notes   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE film_products (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand                 text NOT NULL,
  line                  text NOT NULL,
  tier                  text NOT NULL CHECK (tier IN ('carbon','carbon-ceramic','nano-ceramic','wrap-vinyl','architectural')),
  cost_per_ft_cents     int NOT NULL DEFAULT 0 CHECK (cost_per_ft_cents >= 0),
  warranty_term_months  int CHECK (warranty_term_months IS NULL OR warranty_term_months > 0), -- NULL = lifetime
  labor_warranty_months int CHECK (labor_warranty_months IS NULL OR labor_warranty_months > 0),
  active                boolean NOT NULL DEFAULT true,
  UNIQUE (brand, line)
);

CREATE SEQUENCE job_number_seq START 1001;

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            int NOT NULL UNIQUE DEFAULT nextval('job_number_seq'),
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  property_id       uuid REFERENCES properties(id) ON DELETE RESTRICT,
  stage             text NOT NULL DEFAULT 'new_lead'
                    CHECK (stage IN ('new_lead','quoted','booked','in_bay','completed','paid','lost')),
  lead_source       text,
  campaign          text,
  lost_reason       text CHECK (lost_reason IS NULL OR lost_reason IN ('price','went_elsewhere','no_response','illegal_shade','other')),
  discount_cents    int NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_rate_bp       int NOT NULL DEFAULT 825 CHECK (tax_rate_bp BETWEEN 0 AND 10000), -- basis points, 8.25% Dallas
  waiver_signed_at  timestamptz,
  waiver_name       text,
  assigned_to       uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_claim_id   uuid, -- FK added after warranty_claims exists
  is_warranty_redo  boolean NOT NULL DEFAULT false,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- A job is for a vehicle or a property, never both. Leads may have neither yet.
  CONSTRAINT job_subject_xor CHECK (NOT (vehicle_id IS NOT NULL AND property_id IS NOT NULL)),
  CONSTRAINT job_lost_reason CHECK ((stage = 'lost') = (lost_reason IS NOT NULL))
);
CREATE INDEX jobs_contact_idx ON jobs(contact_id);
CREATE INDEX jobs_stage_idx ON jobs(stage);

CREATE TABLE job_line_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  service          text NOT NULL CHECK (service IN ('full_tint','front_two','windshield','sun_strip','pano_roof',
                     'removal','wrap','chrome_delete','lights','flat_glass','other')),
  windows          text[] NOT NULL DEFAULT '{}',
  shade_vlt        int CHECK (shade_vlt IS NULL OR shade_vlt IN (5,15,20,35,40,50,70,80)),
  film_product_id  uuid REFERENCES film_products(id) ON DELETE RESTRICT,
  qty              int NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents int NOT NULL CHECK (unit_price_cents >= 0),
  description      text
);
CREATE INDEX line_items_job_idx ON job_line_items(job_id);

CREATE TABLE appointments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  bay          int NOT NULL DEFAULT 1 CHECK (bay > 0),
  installer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','arrived','no_show','done','cancelled')),
  CONSTRAINT appt_order CHECK (ends_at > starts_at)
);
CREATE INDEX appointments_time_idx ON appointments(starts_at);

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  amount_cents       int NOT NULL CHECK (amount_cents > 0),
  kind               text NOT NULL CHECK (kind IN ('deposit','balance','refund')),
  method             text NOT NULL CHECK (method IN ('card','cash','zelle','affirm','afterpay','terms')),
  processor_fee_cents int NOT NULL DEFAULT 0 CHECK (processor_fee_cents >= 0),
  external_ref       text UNIQUE,
  paid_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_job_idx ON payments(job_id);

CREATE TABLE warranties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL UNIQUE,
  job_id          uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  property_id     uuid REFERENCES properties(id) ON DELETE SET NULL,
  coverage        text NOT NULL CHECK (coverage IN ('manufacturer','labor')),
  film_brand      text,
  film_line       text,
  windows_covered text[] NOT NULL DEFAULT '{}',
  starts_on       date NOT NULL,
  expires_on      date, -- NULL = lifetime
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided','claimed')),
  void_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, coverage, film_brand, film_line)
);
CREATE INDEX warranties_contact_idx ON warranties(contact_id);

CREATE TABLE warranty_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_id       uuid NOT NULL REFERENCES warranties(id) ON DELETE RESTRICT,
  reported_at       timestamptz NOT NULL DEFAULT now(),
  issue             text NOT NULL CHECK (issue IN ('bubbling','peeling','fading','edge_lift','contamination','other')),
  description       text,
  decision          text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','covered','not_covered','goodwill')),
  resolution_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL
);
ALTER TABLE jobs ADD CONSTRAINT jobs_parent_claim_fk
  FOREIGN KEY (parent_claim_id) REFERENCES warranty_claims(id) ON DELETE SET NULL;

CREATE TABLE partners (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text NOT NULL,
  email  text
);

CREATE TABLE rev_share_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  percent_bp  int NOT NULL CHECK (percent_bp BETWEEN 1 AND 10000), -- 2000 = 20%
  basis       text NOT NULL CHECK (basis IN ('gross','net_of_material')),
  sources     text[] NOT NULL DEFAULT '{}', -- empty = all lead sources
  starts_on   date NOT NULL,
  ends_on     date,
  CONSTRAINT rule_dates CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

-- Append-only ledger. Refunds create negative lines.
CREATE TABLE payout_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  rule_id       uuid NOT NULL REFERENCES rev_share_rules(id) ON DELETE RESTRICT,
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  period        text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  basis_cents   int NOT NULL,
  share_cents   int NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, rule_id)
);

CREATE TABLE messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  job_id       uuid REFERENCES jobs(id) ON DELETE SET NULL,
  channel      text NOT NULL CHECK (channel IN ('sms','whatsapp')),
  direction    text NOT NULL CHECK (direction IN ('in','out')),
  body         text NOT NULL DEFAULT '',
  media_urls   text[] NOT NULL DEFAULT '{}',
  external_id  text UNIQUE, -- Twilio MessageSid; makes webhook retries idempotent
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_contact_idx ON messages(contact_id, created_at);

CREATE TABLE notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('contact','vehicle','property','job','warranty','claim')),
  subject_id   uuid NOT NULL,
  type         text NOT NULL DEFAULT 'general' CHECK (type IN ('general','call','text','internal','install','inspection')),
  body         text NOT NULL CHECK (length(trim(body)) > 0),
  pinned       boolean NOT NULL DEFAULT false,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_subject_idx ON notes(subject_type, subject_id);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  due_at       timestamptz,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  owner_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_type text,
  subject_id   uuid,
  auto_rule    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_subject_idx ON activity(subject_type, subject_id, occurred_at);
