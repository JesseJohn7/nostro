/**
 * The PostgreSQL schema, as ordered migrations.
 *
 * Amounts are `NUMERIC(40,0)` raw units plus a `decimals` column: never a
 * float, and wide enough for SEP-41 tokens beyond int64. The database repeats
 * the contract's hard constraints (uniqueness, positive amounts, closed sets
 * of values) as a backstop behind the shared rules in `nostro`.
 *
 * Append new migrations; never edit one that has shipped.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/

/** Quote a schema name after checking it is a plain identifier. */
export function quoteSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid schema name ${JSON.stringify(schema)}: use lowercase letters, digits and _.`)
  }
  return `"${schema}"`
}

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

const KINDS = list(['transfer', 'mint', 'burn', 'clawback', 'fee'])
const DIRECTIONS = list(['credit', 'debit'])
const DISPOSITIONS = list(['pending', 'allocated', 'partial', 'exception', 'ignored'])
const MEMO_TYPES = list(['text', 'id', 'hash', 'return'])
const EXPECTATION_STATUSES = list(['open', 'partially_paid', 'settled', 'cancelled'])
const EXCEPTION_STATUSES = list(['open', 'resolved', 'dismissed'])
const LINE_ROLES = list([
  'cash',
  'issued',
  'receivable',
  'payable',
  'unapplied',
  'customer_credit',
  'unexplained',
  'network_fees',
  'uncategorized_income',
  'uncategorized_expense',
  'conversion',
])
const ENTRY_KINDS = list(['initial', 'reclass', 'correction'])
const MANUAL_ENTRY_KINDS = list(['initial', 'reclass', 'correction', 'conversion', 'manual'])
const CURRENT_LINE_ROLES = list([
  'cash',
  'issued',
  'receivable',
  'payable',
  'unapplied',
  'customer_credit',
  'unexplained',
  'network_fees',
  'uncategorized_income',
  'uncategorized_expense',
  'conversion',
  'refund_clearing',
  'deposit_clearing',
  'redemption_payable',
  'clawback',
  'due_to',
  'due_from',
  'in_transit',
  'opening_balance',
  'other',
])
const CURRENT_ENTRY_KINDS = list(['initial', 'reclass', 'correction', 'conversion', 'manual', 'opening'])
const EVENT_TYPES = list([
  'movement.decided',
  'expectation.partially_paid',
  'expectation.settled',
  'expectation.cancelled',
  'expectation.amended',
  'exception.opened',
  'exception.resolved',
  'exception.dismissed',
])
const EXCEPTION_CODES = list([
  'UNMATCHED_NO_CANDIDATE',
  'AMBIGUOUS_MATCH',
  'WRONG_ASSET',
  'OVERPAYMENT',
  'DUPLICATE_PAYMENT',
  'PARTIAL_UNRESOLVED',
  'LATE_BEYOND_WINDOW',
  'EXPECTATION_EXPIRED',
  'MEMO_MISSING',
  'MEMO_MALFORMED',
  'MEMO_TRUNCATED',
  'UNEXPECTED_CREDIT',
  'UNEXPECTED_DEBIT',
  'REFUND_UNLINKED',
  'BALANCE_ATTESTATION_FAILED',
  'SOURCE_GAP_DETECTED',
  'ENRICHMENT_MISSING',
])

/** Each migration is a function of the quoted schema name. */
export const MIGRATIONS: readonly ((s: string) => string)[] = [
  (s) => `
    CREATE TABLE ${s}.movements (
      id             text PRIMARY KEY,
      seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id      text NOT NULL,
      network        text NOT NULL,
      source         text NOT NULL,
      external_id    text NOT NULL,
      revision       integer NOT NULL CHECK (revision >= 1),
      account        text NOT NULL,
      direction      text NOT NULL CHECK (direction IN (${DIRECTIONS})),
      kind           text NOT NULL CHECK (kind IN (${KINDS})),
      asset          text NOT NULL,
      decimals       smallint NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         numeric(40, 0) NOT NULL CHECK (amount > 0),
      counterparty   text,
      muxed_id       numeric(20, 0),
      memo_type      text CHECK (memo_type IN (${MEMO_TYPES})),
      -- id, hash and return memos; text memos go in memo_text because they
      -- can contain NUL, which a text column cannot hold.
      memo_value     text,
      memo_text      bytea,
      ledger         bigint NOT NULL CHECK (ledger >= 1),
      tx_hash        text,
      operation_id   text,
      occurred_at    timestamptz NOT NULL,
      enrichment     text NOT NULL CHECK (enrichment IN ('complete', 'missing')),
      disposition    text NOT NULL CHECK (disposition IN (${DISPOSITIONS})),
      ignored_reason text,
      created_at     timestamptz NOT NULL,
      CONSTRAINT movements_dedupe UNIQUE (tenant_id, network, source, external_id),
      CHECK ((disposition = 'ignored') = (ignored_reason IS NOT NULL))
    );
    CREATE INDEX movements_queue ON ${s}.movements (tenant_id, disposition, seq);
    CREATE INDEX movements_account ON ${s}.movements (tenant_id, account, seq);

    CREATE TABLE ${s}.expectations (
      id            text PRIMARY KEY,
      seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id     text NOT NULL,
      reference     text NOT NULL,
      account       text NOT NULL,
      direction     text NOT NULL CHECK (direction IN (${DIRECTIONS})),
      asset         text NOT NULL,
      decimals      smallint NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount        numeric(40, 0) NOT NULL CHECK (amount > 0),
      muxed_id      numeric(20, 0),
      memo_type     text CHECK (memo_type IN (${MEMO_TYPES})),
      memo_value    text,
      memo_text     bytea,
      payers        text[] NOT NULL,
      due_at        timestamptz,
      expires_at    timestamptz,
      status        text NOT NULL CHECK (status IN (${EXPECTATION_STATUSES})),
      cancel_reason text,
      metadata      jsonb NOT NULL,
      created_at    timestamptz NOT NULL,
      updated_at    timestamptz NOT NULL,
      CONSTRAINT expectations_reference_unique UNIQUE (tenant_id, reference)
    );
    CREATE INDEX expectations_candidates ON ${s}.expectations (tenant_id, account, asset, status);
    CREATE INDEX expectations_muxed ON ${s}.expectations (tenant_id, muxed_id) WHERE muxed_id IS NOT NULL;

    CREATE TABLE ${s}.allocations (
      id             text PRIMARY KEY,
      seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id      text NOT NULL,
      movement_id    text NOT NULL REFERENCES ${s}.movements (id),
      expectation_id text NOT NULL REFERENCES ${s}.expectations (id),
      asset          text NOT NULL,
      decimals       smallint NOT NULL,
      amount         numeric(40, 0) NOT NULL CHECK (amount > 0),
      strategy       text NOT NULL,
      score          double precision CHECK (score BETWEEN 0 AND 1),
      -- json, not jsonb: the recorded snapshot may quote memo text with \\u0000.
      decision       json,
      created_at     timestamptz NOT NULL,
      CONSTRAINT allocations_unique UNIQUE (movement_id, expectation_id)
    );
    CREATE INDEX allocations_expectation ON ${s}.allocations (expectation_id);

    CREATE TABLE ${s}.decisions (
      seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id   text NOT NULL,
      movement_id text NOT NULL UNIQUE REFERENCES ${s}.movements (id),
      decided_at  timestamptz NOT NULL,
      snapshot    json NOT NULL,
      CONSTRAINT decisions_unique UNIQUE (tenant_id, movement_id)
    );
    CREATE INDEX decisions_range ON ${s}.decisions (tenant_id, decided_at, seq);

    CREATE TABLE ${s}.exceptions (
      id              text PRIMARY KEY,
      seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id       text NOT NULL,
      code            text NOT NULL CHECK (code IN (${EXCEPTION_CODES})),
      status          text NOT NULL CHECK (status IN (${EXCEPTION_STATUSES})),
      movement_id     text REFERENCES ${s}.movements (id),
      expectation_id  text REFERENCES ${s}.expectations (id),
      account         text,
      asset           text,
      decimals        smallint,
      amount          numeric(40, 0),
      detail          text NOT NULL,
      -- json, not jsonb: evidence may quote memo text, and jsonb rejects \\u0000.
      evidence        json NOT NULL,
      opened_at       timestamptz NOT NULL,
      resolved_at     timestamptz,
      resolution_note text,
      CHECK (movement_id IS NOT NULL OR expectation_id IS NOT NULL OR account IS NOT NULL),
      CHECK ((amount IS NULL) = (asset IS NULL) AND (asset IS NULL) = (decimals IS NULL))
    );
    CREATE INDEX exceptions_queue ON ${s}.exceptions (tenant_id, status, code);
    CREATE INDEX exceptions_movement ON ${s}.exceptions (movement_id) WHERE movement_id IS NOT NULL;

    CREATE TABLE ${s}.cursors (
      tenant_id text NOT NULL,
      network   text NOT NULL,
      source    text NOT NULL,
      account   text NOT NULL,
      -- NULL until first set: the row exists so a transaction can lock it.
      value     text,
      PRIMARY KEY (tenant_id, network, source, account)
    );
  `,
  // 2: the journal. Append-only, and every entry balances per asset: the
  // database checks that at COMMIT, independently of application code.
  (s) => `
    CREATE TABLE ${s}.journal_entries (
      id           text PRIMARY KEY,
      seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id    text NOT NULL,
      movement_id  text REFERENCES ${s}.movements (id),
      posting_no   integer CHECK (posting_no >= 1),
      kind         text NOT NULL CHECK (kind IN (${ENTRY_KINDS})),
      effective_at timestamptz NOT NULL,
      posted_at    timestamptz NOT NULL,
      description  text NOT NULL,
      CHECK ((movement_id IS NULL) = (posting_no IS NULL)),
      CONSTRAINT journal_posting_unique UNIQUE (movement_id, posting_no)
    );
    -- What accounting periods will filter and lock on.
    CREATE INDEX journal_entries_effective ON ${s}.journal_entries (tenant_id, effective_at);

    CREATE TABLE ${s}.journal_lines (
      entry_id       text NOT NULL REFERENCES ${s}.journal_entries (id),
      line_no        smallint NOT NULL CHECK (line_no >= 1),
      tenant_id      text NOT NULL,
      account        text NOT NULL,
      role           text NOT NULL CHECK (role IN (${LINE_ROLES})),
      side           text NOT NULL CHECK (side IN ('debit', 'credit')),
      asset          text NOT NULL,
      decimals       smallint NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         numeric(40, 0) NOT NULL CHECK (amount > 0),
      expectation_id text REFERENCES ${s}.expectations (id),
      exception_id   text REFERENCES ${s}.exceptions (id),
      PRIMARY KEY (entry_id, line_no)
    );
    CREATE INDEX journal_lines_account ON ${s}.journal_lines (tenant_id, account, asset);

    CREATE FUNCTION ${s}.journal_check_entry(entry text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT count(*) FROM ${s}.journal_lines WHERE entry_id = entry) < 2 THEN
        RAISE EXCEPTION 'journal entry % has fewer than two lines', entry USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM ${s}.journal_lines WHERE entry_id = entry
        GROUP BY asset, decimals
        HAVING sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) <> 0
      ) THEN
        RAISE EXCEPTION 'journal entry % does not balance', entry USING ERRCODE = 'check_violation';
      END IF;
    END $$;
    CREATE FUNCTION ${s}.journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM ${s}.journal_check_entry(NEW.id); RETURN NULL; END $$;
    CREATE FUNCTION ${s}.journal_line_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM ${s}.journal_check_entry(NEW.entry_id); RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON ${s}.journal_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.journal_entry_balanced();
    CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON ${s}.journal_lines
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.journal_line_balanced();

    CREATE FUNCTION ${s}.journal_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'the journal is append-only' USING ERRCODE = 'check_violation'; END $$;
    CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON ${s}.journal_entries
      FOR EACH ROW EXECUTE FUNCTION ${s}.journal_append_only();
    CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON ${s}.journal_lines
      FOR EACH ROW EXECUTE FUNCTION ${s}.journal_append_only();
    CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON ${s}.journal_entries
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.journal_append_only();
    CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON ${s}.journal_lines
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.journal_append_only();
  `,
  // 3: the event log (outbox), written in the same transaction as each
  // decision. The payload is JSON kept as text: jsonb cannot hold the NUL a
  // text memo may carry. Writers take a per-tenant lock before inserting
  // (see PgTx.emit), so events commit in seq order and a consumer reading
  // after a seq can never skip one that commits late.
  (s) => `
    CREATE TABLE ${s}.events (
      seq        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      id         text PRIMARY KEY,
      tenant_id  text NOT NULL,
      type       text NOT NULL CHECK (type IN (${EVENT_TYPES})),
      subject_id text NOT NULL,
      payload    text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE INDEX events_tenant ON ${s}.events (tenant_id, seq);
    CREATE FUNCTION ${s}.events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'the event log is append-only' USING ERRCODE = 'check_violation'; END $$;
    CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON ${s}.events
      FOR EACH ROW EXECUTE FUNCTION ${s}.events_append_only();
    CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON ${s}.events
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.events_append_only();
  `,
  // 4: append-only audit of period closes and reopens.
  (s) => `
    CREATE TABLE ${s}.journal_period_actions (
      seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id  text NOT NULL,
      action     text NOT NULL CHECK (action IN ('close', 'reopen')),
      closed_through timestamptz,
      note       text,
      reason     text,
      created_at timestamptz NOT NULL,
      CHECK (
        (action = 'close' AND closed_through IS NOT NULL AND reason IS NULL) OR
        (action = 'reopen' AND closed_through IS NULL AND note IS NULL AND reason IS NOT NULL)
      )
    );
    CREATE INDEX journal_period_actions_tenant ON ${s}.journal_period_actions (tenant_id, seq);
    CREATE FUNCTION ${s}.journal_period_actions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'journal period actions are append-only' USING ERRCODE = 'check_violation'; END $$;
    CREATE TRIGGER journal_period_actions_append_only BEFORE UPDATE OR DELETE ON ${s}.journal_period_actions
      FOR EACH ROW EXECUTE FUNCTION ${s}.journal_period_actions_append_only();
    CREATE TRIGGER journal_period_actions_no_truncate BEFORE TRUNCATE ON ${s}.journal_period_actions
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.journal_period_actions_append_only();
  `,
  // 5: the text-memo lookup. Normalising is NFKC plus Unicode category
  // removal, so the keys are computed in the application when an expectation
  // is inserted and when this migration backfills older rows. Several
  // expectations can normalise to the same key, so the index is many-to-many.
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.expectation_reference_index (
      tenant_id      text NOT NULL,
      normalized     text NOT NULL,
      expectation_id text NOT NULL REFERENCES ${s}.expectations (id),
      PRIMARY KEY (tenant_id, normalized, expectation_id)
    );
    CREATE INDEX IF NOT EXISTS expectation_reference_keys ON ${s}.expectation_reference_index (tenant_id, normalized);
  `,

  (s) => `
    DO $do$
    DECLARE c text;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = '${s}.exceptions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%code%'
      LOOP
        EXECUTE format('ALTER TABLE ${s}.exceptions DROP CONSTRAINT %I', c);
      END LOOP;
    END $do$;
    ALTER TABLE ${s}.exceptions ADD CONSTRAINT exceptions_code_check CHECK (code IN (${EXCEPTION_CODES}));

    DO $do$
    DECLARE c text;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = '${s}.events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%type%'
      LOOP
        EXECUTE format('ALTER TABLE ${s}.events DROP CONSTRAINT %I', c);
      END LOOP;
    END $do$;
    ALTER TABLE ${s}.events ADD CONSTRAINT events_type_check CHECK (type IN (${EVENT_TYPES}));

    DROP INDEX IF EXISTS ${s}.exceptions_expiry_once;
    CREATE UNIQUE INDEX exceptions_expiry_once ON ${s}.exceptions (tenant_id, expectation_id)
      WHERE code = 'EXPECTATION_EXPIRED' AND expectation_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION ${s}.expectations_muxed_id_unique() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.muxed_id IS NOT DISTINCT FROM OLD.muxed_id THEN
          RETURN NEW;
        END IF;
      END IF;
      IF NEW.muxed_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM ${s}.expectations
        WHERE tenant_id = NEW.tenant_id AND account = NEW.account
          AND muxed_id = NEW.muxed_id AND id <> NEW.id
      ) THEN
        RAISE EXCEPTION 'muxed id % already used on account %', NEW.muxed_id, NEW.account
          USING ERRCODE = 'unique_violation', CONSTRAINT = 'expectation_muxed_id_unique';
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS expectations_muxed_id_insert_unique ON ${s}.expectations;
    CREATE TRIGGER expectations_muxed_id_insert_unique BEFORE INSERT ON ${s}.expectations
      FOR EACH ROW EXECUTE FUNCTION ${s}.expectations_muxed_id_unique();
    DROP TRIGGER IF EXISTS expectations_muxed_id_update_unique ON ${s}.expectations;
    CREATE TRIGGER expectations_muxed_id_update_unique BEFORE UPDATE ON ${s}.expectations
      FOR EACH ROW EXECUTE FUNCTION ${s}.expectations_muxed_id_unique();
  `,

  // 7: export destination high-water marks
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.exports (
      tenant_id     text NOT NULL,
      destination   text NOT NULL,
      last_seq      bigint NOT NULL DEFAULT 0,
      last_exported_at timestamptz NOT NULL DEFAULT now(),
      control_totals jsonb NOT NULL DEFAULT '{}',
      checksum      text NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, destination)
    );
  `,

  // 8: per-tenant accrual mode for expectations
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.accrual_modes (
      tenant_id    text NOT NULL PRIMARY KEY,
      active       boolean NOT NULL DEFAULT false
    );
  `,

  // 9: support batched exception lookups by expectation
  (s) => `
    CREATE INDEX IF NOT EXISTS exceptions_expectation
      ON ${s}.exceptions (tenant_id, expectation_id) WHERE expectation_id IS NOT NULL;
  `,

  // 10: event retention watermark and guarded pruning
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.event_prune_state (
      tenant_id text PRIMARY KEY,
      pruned_through bigint NOT NULL DEFAULT 0 CHECK (pruned_through >= 0)
    );
    CREATE OR REPLACE FUNCTION ${s}.events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('nostro.event_prune', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'the event log is append-only' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF;
      RETURN NULL;
    END $$;
  `,
  (s) => `
    DO $do$
    DECLARE c text;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = '${s}.journal_entries'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'
      LOOP
        EXECUTE format('ALTER TABLE ${s}.journal_entries DROP CONSTRAINT %I', c);
      END LOOP;
    END $do$;
    ALTER TABLE ${s}.journal_entries ADD CONSTRAINT journal_entries_kind_check CHECK (kind IN (${MANUAL_ENTRY_KINDS}));

    ALTER TABLE ${s}.journal_lines DROP CONSTRAINT journal_lines_role_check;
    ALTER TABLE ${s}.journal_lines ADD CONSTRAINT journal_lines_role_check CHECK (role IN (${LINE_ROLES}, 'other'));

    CREATE TABLE IF NOT EXISTS ${s}.movement_valuations (
      tenant_id        text NOT NULL,
      movement_id      text NOT NULL REFERENCES ${s}.movements (id),
      reporting_asset  text NOT NULL,
      price_n          numeric(40, 0) NOT NULL,
      price_d          numeric(40, 0) NOT NULL,
      price_source     text NOT NULL,
      price_timestamp  timestamptz NOT NULL,
      decimals         smallint NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      value            numeric(40, 0) NOT NULL,
      valued_at        timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, movement_id)
    );
    CREATE INDEX IF NOT EXISTS movement_valuations_reporting ON ${s}.movement_valuations (tenant_id, reporting_asset);
  `,
  (s) => `
    CREATE TABLE ${s}.refund_links (
      seq bigint GENERATED ALWAYS AS IDENTITY, id text PRIMARY KEY, tenant_id text NOT NULL,
      credit_movement_id text NOT NULL REFERENCES ${s}.movements(id), refund_movement_id text NOT NULL UNIQUE REFERENCES ${s}.movements(id),
      asset text NOT NULL, decimals smallint NOT NULL CHECK(decimals BETWEEN 0 AND 38),
      amount numeric(40,0) NOT NULL CHECK(amount>0), residual_amount numeric(40,0) NOT NULL CHECK(residual_amount>=0 AND residual_amount<=amount),
      created_at timestamptz NOT NULL
    );
    CREATE INDEX refund_credit ON ${s}.refund_links(tenant_id,credit_movement_id,seq);
    CREATE INDEX IF NOT EXISTS movements_transaction ON ${s}.movements(tenant_id,account,tx_hash);
    CREATE TRIGGER refund_links_no_update BEFORE UPDATE OR DELETE ON ${s}.refund_links
      FOR EACH ROW EXECUTE FUNCTION ${s}.journal_append_only();
    CREATE TRIGGER refund_links_no_truncate BEFORE TRUNCATE ON ${s}.refund_links
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.journal_append_only();
    ALTER TABLE ${s}.journal_lines DROP CONSTRAINT journal_lines_role_check;
    ALTER TABLE ${s}.journal_lines ADD CONSTRAINT journal_lines_role_check CHECK(role IN (${LINE_ROLES},'other','refund_clearing'));
  `,

  // 13: webhook delivery observability and replay audit. A separate,
  // prunable table; the append-only event trigger above is untouched.
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.webhook_delivery_attempts (
      seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      id          text PRIMARY KEY,
      tenant_id   text NOT NULL,
      consumer    text NOT NULL,
      event_id    text NOT NULL,
      event_seq   bigint NOT NULL CHECK (event_seq >= 0),
      attempt_at  timestamptz NOT NULL,
      http_status integer,
      error       text,
      duration_ms integer NOT NULL CHECK (duration_ms >= 0),
      outcome     text NOT NULL CHECK (outcome IN ('success', 'failure')),
      CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
    );
    CREATE INDEX IF NOT EXISTS webhook_attempts_consumer ON ${s}.webhook_delivery_attempts (tenant_id, consumer, seq DESC);
    CREATE INDEX IF NOT EXISTS webhook_attempts_age ON ${s}.webhook_delivery_attempts (tenant_id, consumer, attempt_at);

    CREATE TABLE IF NOT EXISTS ${s}.webhook_rewinds (
      seq       bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      id        text PRIMARY KEY,
      tenant_id text NOT NULL,
      consumer  text NOT NULL,
      from_seq  bigint NOT NULL CHECK (from_seq >= 0),
      to_seq    bigint NOT NULL CHECK (to_seq >= 0),
      actor     text NOT NULL,
      at        timestamptz NOT NULL,
      CHECK (to_seq < from_seq)
    );
    CREATE INDEX IF NOT EXISTS webhook_rewinds_consumer ON ${s}.webhook_rewinds (tenant_id, consumer, seq DESC);
  `,

  // 14: amount fingerprints. A nullable sub-unit suffix that makes the
  // invoiced amount unique per open expectation on a (account, asset) pair.
  // The partial unique index (WHERE status = 'open') enforces uniqueness only
  // while the expectation is live; settled, cancelled and expired rows keep
  // their suffix for the audit trail without blocking reuse.
  (s) => `
    ALTER TABLE ${s}.expectations
      ADD COLUMN IF NOT EXISTS fingerprint_suffix numeric(40, 0)
        CHECK (fingerprint_suffix > 0);
    CREATE UNIQUE INDEX IF NOT EXISTS expectations_fingerprint
      ON ${s}.expectations (tenant_id, account, asset, fingerprint_suffix)
      WHERE status = 'open' AND fingerprint_suffix IS NOT NULL;
  `,
  (s) => `
    ALTER TABLE ${s}.journal_entries DROP CONSTRAINT journal_entries_kind_check;
    ALTER TABLE ${s}.journal_entries ADD CONSTRAINT journal_entries_kind_check CHECK (kind IN (${CURRENT_ENTRY_KINDS}));
    ALTER TABLE ${s}.journal_lines DROP CONSTRAINT journal_lines_role_check;
    ALTER TABLE ${s}.journal_lines ADD CONSTRAINT journal_lines_role_check CHECK (role IN (${CURRENT_LINE_ROLES}));
  `,
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.account_openings (
      id            text PRIMARY KEY,
      tenant_id     text NOT NULL,
      network       text NOT NULL,
      account       text NOT NULL,
      ledger        bigint NOT NULL CHECK (ledger >= 1),
      occurred_at   timestamptz NOT NULL,
      balances_json text NOT NULL,
      note          text,
      created_at    timestamptz NOT NULL,
      UNIQUE (tenant_id, network, account)
    );
    CREATE INDEX IF NOT EXISTS account_openings_tenant ON ${s}.account_openings (tenant_id, network, account);
  `,
  (s) => `
    ALTER TABLE ${s}.movements ADD COLUMN IF NOT EXISTS entity_id text;
    CREATE INDEX IF NOT EXISTS movements_entity ON ${s}.movements (tenant_id, entity_id, seq);
    ALTER TABLE ${s}.journal_lines ADD COLUMN IF NOT EXISTS entity_id text;
    CREATE INDEX IF NOT EXISTS journal_lines_entity ON ${s}.journal_lines (tenant_id, entity_id, entry_id);

    CREATE TABLE IF NOT EXISTS ${s}.entities (
      id          text NOT NULL,
      tenant_id   text NOT NULL,
      name        text NOT NULL,
      created_at  timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );

    CREATE TABLE IF NOT EXISTS ${s}.account_entities (
      tenant_id   text NOT NULL,
      network     text NOT NULL,
      account     text NOT NULL,
      entity_id   text NOT NULL,
      created_at  timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, network, account)
    );
    CREATE INDEX IF NOT EXISTS account_entities_entity ON ${s}.account_entities (tenant_id, entity_id);

    CREATE TABLE IF NOT EXISTS ${s}.internal_transfer_links (
      id             text PRIMARY KEY,
      tenant_id      text NOT NULL,
      network        text NOT NULL,
      tx_hash        text NOT NULL,
      movement_a     text NOT NULL REFERENCES ${s}.movements (id),
      movement_b     text NOT NULL REFERENCES ${s}.movements (id),
      same_entity    boolean NOT NULL,
      created_at     timestamptz NOT NULL,
      CHECK (movement_a <> movement_b),
      UNIQUE (tenant_id, network, tx_hash, movement_a, movement_b)
    );
    CREATE OR REPLACE FUNCTION ${s}.internal_transfer_unique_movement() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM ${s}.internal_transfer_links
        WHERE tenant_id = NEW.tenant_id
          AND (movement_a IN (NEW.movement_a, NEW.movement_b)
            OR movement_b IN (NEW.movement_a, NEW.movement_b))
      ) THEN
        RAISE EXCEPTION 'a movement is already part of another internal transfer';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS internal_transfer_unique_movement ON ${s}.internal_transfer_links;
    CREATE TRIGGER internal_transfer_unique_movement
      BEFORE INSERT ON ${s}.internal_transfer_links
      FOR EACH ROW EXECUTE FUNCTION ${s}.internal_transfer_unique_movement();
  `,
  // 15: API keys, watched accounts and sync state. Keys hold only a SHA-256
  // digest; scopes are a JSON array the server interprets.
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.api_keys (
      id           text PRIMARY KEY,
      tenant_id    text NOT NULL,
      label        text NOT NULL,
      digest       text NOT NULL CONSTRAINT api_keys_digest_unique UNIQUE CHECK (length(digest) = 64),
      scopes       jsonb NOT NULL,
      created_at   timestamptz NOT NULL,
      revoked_at   timestamptz,
      last_used_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS api_keys_tenant ON ${s}.api_keys (tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS ${s}.watched_accounts (
      tenant_id text NOT NULL,
      account   text NOT NULL,
      source    text NOT NULL CHECK (source IN ('config', 'api')),
      added_at  timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, account)
    );

    CREATE TABLE IF NOT EXISTS ${s}.sync_state (
      tenant_id       text NOT NULL,
      network         text NOT NULL,
      source          text NOT NULL,
      account         text NOT NULL,
      cursor          text,
      last_attempt_at timestamptz NOT NULL,
      last_success_at timestamptz,
      caught_up       boolean NOT NULL,
      last_error      text,
      last_error_at   timestamptz,
      PRIMARY KEY (tenant_id, network, source, account)
    );
  `,
  // 19: the engine decision behind every automatic allocation and every other
  // decided disposition, for audit and read-only replay.
  (s) => `
    ALTER TABLE ${s}.allocations ADD COLUMN IF NOT EXISTS decision json;
    CREATE TABLE IF NOT EXISTS ${s}.decisions (
      seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      tenant_id   text NOT NULL,
      movement_id text NOT NULL UNIQUE REFERENCES ${s}.movements (id),
      decided_at  timestamptz NOT NULL,
      snapshot    json NOT NULL,
      CONSTRAINT decisions_unique UNIQUE (tenant_id, movement_id)
    );
    CREATE INDEX IF NOT EXISTS decisions_range ON ${s}.decisions (tenant_id, decided_at, seq);
  `,
  (s) => `
    CREATE TABLE IF NOT EXISTS ${s}.schedules (
      id                text PRIMARY KEY,
      tenant_id         text NOT NULL,
      reference_pattern text NOT NULL,
      account           text NOT NULL,
      direction         text NOT NULL CHECK (direction IN ('credit','debit')),
      asset             text NOT NULL,
      decimals          integer NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount            text NOT NULL CHECK (amount ~ '^[1-9][0-9]*
),
      memo_type         text CHECK (memo_type IN ('text','id','hash','return')),
      memo_value        text,
      memo_text         bytea,
      payers            jsonb NOT NULL,
      cadence           jsonb NOT NULL,
      start_at          timestamptz NOT NULL,
      end_at            timestamptz,
      ended_at          timestamptz,
      created_at        timestamptz NOT NULL,
      updated_at        timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_tenant ON ${s}.schedules (tenant_id, ended_at, start_at);
  `,
]
