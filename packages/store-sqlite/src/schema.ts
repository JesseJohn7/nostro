/**
 * The SQLite schema, as ordered migrations tracked in `PRAGMA user_version`.
 *
 * SQLite integers stop at 64 bits, so amounts are stored as decimal text and
 * constrained to positive integers without leading zeros; sums are taken in
 * application code as bigints. Text memos are BLOBs so NUL survives.
 *
 * Append new migrations; never edit one that has shipped.
 */

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
const EVENT_TYPES = [
  'movement.decided',
  'expectation.partially_paid',
  'expectation.settled',
  'expectation.cancelled',
  'expectation.amended',
  'exception.opened',
  'exception.resolved',
  'exception.dismissed',
]
const appendOnly = (table: string) => `
    CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'the journal is append-only'); END;
    CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'the journal is append-only'); END;`
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

/** A positive integer in decimal text, no sign, no leading zero. */
const positive = (column: string) =>
  `CHECK (typeof(${column}) = 'text' AND ${column} GLOB '[1-9]*' AND ${column} NOT GLOB '*[^0-9]*')`

export const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE movements (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT NOT NULL UNIQUE,
      tenant_id      TEXT NOT NULL,
      network        TEXT NOT NULL,
      source         TEXT NOT NULL,
      external_id    TEXT NOT NULL,
      revision       INTEGER NOT NULL CHECK (revision >= 1),
      account        TEXT NOT NULL,
      direction      TEXT NOT NULL CHECK (direction IN (${DIRECTIONS})),
      kind           TEXT NOT NULL CHECK (kind IN (${KINDS})),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         TEXT NOT NULL ${positive('amount')},
      counterparty   TEXT,
      muxed_id       TEXT,
      memo_type      TEXT CHECK (memo_type IN (${MEMO_TYPES})),
      memo_value     TEXT,
      memo_text      BLOB,
      ledger         INTEGER NOT NULL CHECK (ledger >= 1),
      tx_hash        TEXT,
      operation_id   TEXT,
      occurred_at    INTEGER NOT NULL,
      enrichment     TEXT NOT NULL CHECK (enrichment IN ('complete', 'missing')),
      disposition    TEXT NOT NULL CHECK (disposition IN (${DISPOSITIONS})),
      ignored_reason TEXT,
      created_at     INTEGER NOT NULL,
      UNIQUE (tenant_id, network, source, external_id),
      CHECK ((disposition = 'ignored') = (ignored_reason IS NOT NULL))
    );
    CREATE INDEX movements_queue ON movements (tenant_id, disposition, seq);
    CREATE INDEX movements_account ON movements (tenant_id, account, seq);

    CREATE TABLE expectations (
      seq           INTEGER PRIMARY KEY AUTOINCREMENT,
      id            TEXT NOT NULL UNIQUE,
      tenant_id     TEXT NOT NULL,
      reference     TEXT NOT NULL,
      account       TEXT NOT NULL,
      direction     TEXT NOT NULL CHECK (direction IN (${DIRECTIONS})),
      asset         TEXT NOT NULL,
      decimals      INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount        TEXT NOT NULL ${positive('amount')},
      muxed_id      TEXT,
      memo_type     TEXT CHECK (memo_type IN (${MEMO_TYPES})),
      memo_value    TEXT,
      memo_text     BLOB,
      payers        TEXT NOT NULL,
      due_at        INTEGER,
      expires_at    INTEGER,
      status        TEXT NOT NULL CHECK (status IN (${EXPECTATION_STATUSES})),
      cancel_reason TEXT,
      metadata      TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE (tenant_id, reference)
    );
    CREATE INDEX expectations_candidates ON expectations (tenant_id, account, asset, status);
    CREATE INDEX expectations_muxed ON expectations (tenant_id, muxed_id) WHERE muxed_id IS NOT NULL;

    CREATE TABLE allocations (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT NOT NULL UNIQUE,
      tenant_id      TEXT NOT NULL,
      movement_id    TEXT NOT NULL REFERENCES movements (id),
      expectation_id TEXT NOT NULL REFERENCES expectations (id),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL,
      amount         TEXT NOT NULL ${positive('amount')},
      strategy       TEXT NOT NULL,
      score          REAL CHECK (score BETWEEN 0 AND 1),
      created_at     INTEGER NOT NULL,
      UNIQUE (movement_id, expectation_id)
    );
    CREATE INDEX allocations_expectation ON allocations (expectation_id);

    CREATE TABLE exceptions (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      tenant_id       TEXT NOT NULL,
      code            TEXT NOT NULL CHECK (code IN (${EXCEPTION_CODES})),
      status          TEXT NOT NULL CHECK (status IN (${EXCEPTION_STATUSES})),
      movement_id     TEXT REFERENCES movements (id),
      expectation_id  TEXT REFERENCES expectations (id),
      account         TEXT,
      asset           TEXT,
      decimals        INTEGER,
      amount          TEXT,
      detail          TEXT NOT NULL,
      evidence        TEXT NOT NULL,
      opened_at       INTEGER NOT NULL,
      resolved_at     INTEGER,
      resolution_note TEXT,
      CHECK (movement_id IS NOT NULL OR expectation_id IS NOT NULL OR account IS NOT NULL),
      CHECK ((amount IS NULL) = (asset IS NULL) AND (asset IS NULL) = (decimals IS NULL))
    );
    CREATE INDEX exceptions_queue ON exceptions (tenant_id, status, code);
    CREATE INDEX exceptions_movement ON exceptions (movement_id) WHERE movement_id IS NOT NULL;

    CREATE TABLE cursors (
      tenant_id TEXT NOT NULL,
      network   TEXT NOT NULL,
      source    TEXT NOT NULL,
      account   TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (tenant_id, network, source, account)
    );
  `,
  // 2: the journal, append-only. Unlike PostgreSQL there is no balance
  // trigger: amounts are text beyond 64 bits and SQLite cannot sum them
  // exactly, so balance is enforced by the shared rule in code.
  `
    CREATE TABLE journal_entries (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      tenant_id    TEXT NOT NULL,
      movement_id  TEXT REFERENCES movements (id),
      posting_no   INTEGER CHECK (posting_no >= 1),
      kind         TEXT NOT NULL CHECK (kind IN (${ENTRY_KINDS})),
      effective_at INTEGER NOT NULL,
      posted_at    INTEGER NOT NULL,
      description  TEXT NOT NULL,
      CHECK ((movement_id IS NULL) = (posting_no IS NULL)),
      UNIQUE (movement_id, posting_no)
    );
    CREATE INDEX journal_entries_effective ON journal_entries (tenant_id, effective_at);

    CREATE TABLE journal_lines (
      entry_id       TEXT NOT NULL REFERENCES journal_entries (id),
      line_no        INTEGER NOT NULL CHECK (line_no >= 1),
      tenant_id      TEXT NOT NULL,
      account        TEXT NOT NULL,
      role           TEXT NOT NULL CHECK (role IN (${LINE_ROLES})),
      side           TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         TEXT NOT NULL ${positive('amount')},
      expectation_id TEXT REFERENCES expectations (id),
      exception_id   TEXT REFERENCES exceptions (id),
      PRIMARY KEY (entry_id, line_no)
    );
    CREATE INDEX journal_lines_account ON journal_lines (tenant_id, account, asset);
    ${appendOnly('journal_entries')}
    ${appendOnly('journal_lines')}
  `,
  // 3: look up a movement's entries without scanning the tenant's whole
  // journal. Without it SQLite answers through the (tenant_id, effective_at)
  // index, and posting a large backlog becomes quadratic.
  `
    CREATE INDEX journal_entries_movement ON journal_entries (tenant_id, movement_id, seq);
  `,
  // 4: the event log (outbox), written in the same transaction as each
  // decision. Append-only; consumers keep their place in cursors.
  `
    CREATE TABLE events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT NOT NULL UNIQUE,
      tenant_id  TEXT NOT NULL,
      type       TEXT NOT NULL CHECK (type IN (${list(EVENT_TYPES)})),
      subject_id TEXT NOT NULL,
      payload    TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX events_tenant ON events (tenant_id, seq);
    CREATE TRIGGER events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
  `,
  // 5: append-only audit of period closes and reopens.
  `
    CREATE TABLE journal_period_actions (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('close', 'reopen')),
      closed_through INTEGER,
      note       TEXT,
      reason     TEXT,
      created_at INTEGER NOT NULL,
      CHECK (
        (action = 'close' AND closed_through IS NOT NULL AND reason IS NULL) OR
        (action = 'reopen' AND closed_through IS NULL AND note IS NULL AND reason IS NOT NULL)
      )
    );
    CREATE INDEX journal_period_actions_tenant ON journal_period_actions (tenant_id, seq);
    CREATE TRIGGER journal_period_actions_no_update BEFORE UPDATE ON journal_period_actions
      BEGIN SELECT RAISE(ABORT, 'journal period actions are append-only'); END;
    CREATE TRIGGER journal_period_actions_no_delete BEFORE DELETE ON journal_period_actions
      BEGIN SELECT RAISE(ABORT, 'journal period actions are append-only'); END;
  `,
  // 6: find a settled invoice from the text memo a payer quoted. Normalising
  // is done in the application (it is NFKC plus Unicode category removal), so
  // the keys are computed when an expectation is inserted and when this
  // migration backfills rows written before the index existed. A key can name
  // more than one expectation, hence the many-to-many table and no UNIQUE on
  // (tenant, key) alone.
  `
    CREATE TABLE IF NOT EXISTS expectation_reference_index (
      tenant_id      TEXT NOT NULL,
      normalized     TEXT NOT NULL,
      expectation_id TEXT NOT NULL REFERENCES expectations (id),
      PRIMARY KEY (tenant_id, normalized, expectation_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS expectation_reference_keys
      ON expectation_reference_index (tenant_id, normalized);
  `,
  // 7: export destination high-water marks
  `
    CREATE TABLE IF NOT EXISTS exports (
      tenant_id     TEXT NOT NULL,
      destination   TEXT NOT NULL,
      last_seq      INTEGER NOT NULL DEFAULT 0,
      last_exported_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
      control_totals TEXT NOT NULL DEFAULT '{}',
      checksum      TEXT NOT NULL DEFAULT '',
PRIMARY KEY (tenant_id, destination)
    );
  `,
  // 8: per-tenant accrual mode for expectations
  `
    CREATE TABLE IF NOT EXISTS accrual_modes (
      tenant_id     TEXT NOT NULL PRIMARY KEY,
      active        INTEGER NOT NULL DEFAULT 0
    );
  `,
`
    CREATE TABLE exceptions_new (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      tenant_id       TEXT NOT NULL,
      code            TEXT NOT NULL CHECK (code IN (${EXCEPTION_CODES})),
      status          TEXT NOT NULL CHECK (status IN (${EXCEPTION_STATUSES})),
      movement_id     TEXT REFERENCES movements (id),
      expectation_id  TEXT REFERENCES expectations (id),
      account         TEXT,
      asset           TEXT,
      decimals        INTEGER,
      amount          TEXT,
      detail          TEXT NOT NULL,
      evidence        TEXT NOT NULL,
      opened_at       INTEGER NOT NULL,
      resolved_at     INTEGER,
      resolution_note TEXT,
      CHECK (movement_id IS NOT NULL OR expectation_id IS NOT NULL OR account IS NOT NULL),
      CHECK ((amount IS NULL) = (asset IS NULL) AND (asset IS NULL) = (decimals IS NULL))
    );
    INSERT INTO exceptions_new (seq,id,tenant_id,code,status,movement_id,expectation_id,account,asset,decimals,amount,detail,evidence,opened_at,resolved_at,resolution_note)
      SELECT seq,id,tenant_id,code,status,movement_id,expectation_id,account,asset,decimals,amount,detail,evidence,opened_at,resolved_at,resolution_note FROM exceptions;

    CREATE TABLE journal_lines_new (
      entry_id       TEXT NOT NULL REFERENCES journal_entries (id),
      line_no        INTEGER NOT NULL CHECK (line_no >= 1),
      tenant_id      TEXT NOT NULL,
      account        TEXT NOT NULL,
      role           TEXT NOT NULL CHECK (role IN (${LINE_ROLES})),
      side           TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         TEXT NOT NULL ${positive('amount')},
      expectation_id TEXT REFERENCES expectations (id),
      exception_id   TEXT REFERENCES exceptions_new (id),
      PRIMARY KEY (entry_id, line_no)
    );
    INSERT INTO journal_lines_new (entry_id,line_no,tenant_id,account,role,side,asset,decimals,amount,expectation_id,exception_id)
      SELECT entry_id,line_no,tenant_id,account,role,side,asset,decimals,amount,expectation_id,exception_id FROM journal_lines;
    DROP TABLE journal_lines;
    DROP TABLE exceptions;
    ALTER TABLE exceptions_new RENAME TO exceptions;
    ALTER TABLE journal_lines_new RENAME TO journal_lines;
    CREATE INDEX exceptions_queue ON exceptions (tenant_id, status, code);
    CREATE INDEX exceptions_movement ON exceptions (movement_id) WHERE movement_id IS NOT NULL;
    CREATE UNIQUE INDEX exceptions_expiry_once ON exceptions (tenant_id, expectation_id)
      WHERE code = 'EXPECTATION_EXPIRED' AND expectation_id IS NOT NULL;
    CREATE INDEX journal_lines_account ON journal_lines (tenant_id, account, asset);
    ${appendOnly('journal_lines')}

    CREATE TABLE events_new (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT NOT NULL UNIQUE,
      tenant_id  TEXT NOT NULL,
      type       TEXT NOT NULL CHECK (type IN (${list(EVENT_TYPES)})),
      subject_id TEXT NOT NULL,
      payload    TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL
    );
    INSERT INTO events_new (seq,id,tenant_id,type,subject_id,payload,created_at)
      SELECT seq,id,tenant_id,type,subject_id,payload,created_at FROM events;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;
    CREATE INDEX events_tenant ON events (tenant_id, seq);
    CREATE TRIGGER events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;

    DROP TRIGGER IF EXISTS expectations_muxed_id_insert_unique;
    DROP TRIGGER IF EXISTS expectations_muxed_id_update_unique;
    CREATE TRIGGER expectations_muxed_id_insert_unique BEFORE INSERT ON expectations
      WHEN NEW.muxed_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM expectations
        WHERE tenant_id = NEW.tenant_id AND account = NEW.account AND muxed_id = NEW.muxed_id
      )
      BEGIN SELECT RAISE(ABORT, 'muxed id already used on account'); END;
    CREATE TRIGGER expectations_muxed_id_update_unique BEFORE UPDATE ON expectations
      WHEN NEW.muxed_id IS NOT NULL AND NEW.muxed_id IS NOT OLD.muxed_id AND EXISTS (
        SELECT 1 FROM expectations
        WHERE tenant_id = NEW.tenant_id AND account = NEW.account AND muxed_id = NEW.muxed_id AND id <> NEW.id
      )
      BEGIN SELECT RAISE(ABORT, 'muxed id already used on account'); END;
  `,

  // Support batched exception lookups by expectation.
  `
    CREATE INDEX IF NOT EXISTS exceptions_expectation
      ON exceptions (tenant_id, expectation_id) WHERE expectation_id IS NOT NULL;
  `,

  // Event retention watermark and guarded pruning.
  `
    CREATE TABLE IF NOT EXISTS event_prune_state (
      tenant_id TEXT PRIMARY KEY,
      pruned_through INTEGER NOT NULL DEFAULT 0 CHECK (pruned_through >= 0)
    );
    DROP TRIGGER IF EXISTS events_no_delete;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events
      WHEN nostro_event_prune_allowed() = 0
      BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
  `,
  // 12: manual journal entry kind, and movement valuations
  `
    CREATE TEMP TABLE saved_journal_lines AS SELECT * FROM journal_lines;
    DROP TABLE journal_lines;
    DROP TABLE IF EXISTS journal_entries_new;
    CREATE TABLE journal_entries_new (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      tenant_id    TEXT NOT NULL,
      movement_id  TEXT REFERENCES movements (id),
      posting_no   INTEGER CHECK (posting_no >= 1),
      kind         TEXT NOT NULL CHECK (kind IN (${MANUAL_ENTRY_KINDS})),
      effective_at INTEGER NOT NULL,
      posted_at    INTEGER NOT NULL,
      description  TEXT NOT NULL,
      CHECK ((movement_id IS NULL) = (posting_no IS NULL)),
      UNIQUE (movement_id, posting_no)
    );
    INSERT INTO journal_entries_new (seq, id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description)
      SELECT seq, id, tenant_id, movement_id, posting_no, kind, effective_at, posted_at, description FROM journal_entries;
    DROP TABLE journal_entries;
    ALTER TABLE journal_entries_new RENAME TO journal_entries;
    CREATE INDEX journal_entries_effective ON journal_entries (tenant_id, effective_at);
    CREATE INDEX journal_entries_movement ON journal_entries (tenant_id, movement_id, seq);
    ${appendOnly('journal_entries')}
    CREATE TABLE journal_lines (
      entry_id TEXT NOT NULL REFERENCES journal_entries(id),
      line_no INTEGER NOT NULL CHECK (line_no >= 1), tenant_id TEXT NOT NULL,
      account TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN (${LINE_ROLES}, 'other')),
      side TEXT NOT NULL CHECK (side IN ('debit','credit')),
      asset TEXT NOT NULL, decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount TEXT NOT NULL ${positive('amount')},
      expectation_id TEXT REFERENCES expectations(id), exception_id TEXT REFERENCES exceptions(id),
      PRIMARY KEY(entry_id,line_no)
    );
    INSERT INTO journal_lines SELECT * FROM saved_journal_lines;
    DROP TABLE saved_journal_lines;
    CREATE INDEX journal_lines_account ON journal_lines(tenant_id,account,asset);
    ${appendOnly('journal_lines')}

    CREATE TABLE IF NOT EXISTS movement_valuations (
      tenant_id        TEXT NOT NULL,
      movement_id      TEXT NOT NULL REFERENCES movements (id),
      reporting_asset  TEXT NOT NULL,
      price_n          TEXT NOT NULL,
      price_d          TEXT NOT NULL,
      price_source     TEXT NOT NULL,
      price_timestamp  INTEGER NOT NULL,
      decimals         INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      value            TEXT NOT NULL,
      valued_at        INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, movement_id)
    );
    CREATE INDEX IF NOT EXISTS movement_valuations_reporting ON movement_valuations (tenant_id, reporting_asset);
  `,
  `
    CREATE TABLE refund_links (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL,
      credit_movement_id TEXT NOT NULL REFERENCES movements(id), refund_movement_id TEXT NOT NULL UNIQUE REFERENCES movements(id),
      asset TEXT NOT NULL, decimals INTEGER NOT NULL CHECK(decimals BETWEEN 0 AND 38),
      amount TEXT NOT NULL ${positive('amount')}, residual_amount TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX refund_credit ON refund_links(tenant_id,credit_movement_id,seq);
    CREATE INDEX IF NOT EXISTS movements_transaction ON movements(tenant_id,account,tx_hash);
    ${appendOnly('refund_links')}
    CREATE TABLE journal_lines_refunds (
      entry_id TEXT NOT NULL REFERENCES journal_entries(id), line_no INTEGER NOT NULL CHECK(line_no>=1),
      tenant_id TEXT NOT NULL, account TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN (${LINE_ROLES},'other','refund_clearing')),
      side TEXT NOT NULL CHECK(side IN ('debit','credit')), asset TEXT NOT NULL, decimals INTEGER NOT NULL CHECK(decimals BETWEEN 0 AND 38),
      amount TEXT NOT NULL ${positive('amount')}, expectation_id TEXT REFERENCES expectations(id), exception_id TEXT REFERENCES exceptions(id),
      PRIMARY KEY(entry_id,line_no)
    );
    INSERT INTO journal_lines_refunds SELECT * FROM journal_lines;
    DROP TABLE journal_lines;
    ALTER TABLE journal_lines_refunds RENAME TO journal_lines;
    CREATE INDEX journal_lines_account ON journal_lines(tenant_id,account,asset);
    ${appendOnly('journal_lines')}
  `,

  // 14: webhook delivery observability and replay audit. Separate from the
  // append-only event log: attempts are bounded and pruned, rewinds are an
  // audit trail of who moved a consumer back.
  `
    CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      id          TEXT NOT NULL UNIQUE,
      tenant_id   TEXT NOT NULL,
      consumer    TEXT NOT NULL,
      event_id    TEXT NOT NULL,
      event_seq   INTEGER NOT NULL CHECK (event_seq >= 0),
      attempt_at  INTEGER NOT NULL,
      http_status INTEGER,
      error       TEXT,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      outcome     TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
      CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
    );
    CREATE INDEX IF NOT EXISTS webhook_attempts_consumer ON webhook_delivery_attempts (tenant_id, consumer, seq DESC);
    CREATE INDEX IF NOT EXISTS webhook_attempts_age ON webhook_delivery_attempts (tenant_id, consumer, attempt_at);

    CREATE TABLE IF NOT EXISTS webhook_rewinds (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT NOT NULL UNIQUE,
      tenant_id  TEXT NOT NULL,
      consumer   TEXT NOT NULL,
      from_seq   INTEGER NOT NULL CHECK (from_seq >= 0),
      to_seq     INTEGER NOT NULL CHECK (to_seq >= 0),
      actor      TEXT NOT NULL,
      at         INTEGER NOT NULL,
      CHECK (to_seq < from_seq)
    );
    CREATE INDEX IF NOT EXISTS webhook_rewinds_consumer ON webhook_rewinds (tenant_id, consumer, seq DESC);
  `,

  // 15: amount fingerprints. A nullable positive-integer suffix stored as
  // decimal text. SQLite has no partial unique index with a WHERE clause on a
  // non-indexed column, so uniqueness among open expectations is enforced by
  // triggers that fire on INSERT and on the status UPDATE that opens a new row.
  `
    ALTER TABLE expectations ADD COLUMN fingerprint_suffix TEXT;
    CREATE TRIGGER expectations_fingerprint_insert
      BEFORE INSERT ON expectations
      WHEN NEW.fingerprint_suffix IS NOT NULL AND NEW.status = 'open'
        AND EXISTS (
          SELECT 1 FROM expectations
          WHERE tenant_id = NEW.tenant_id
            AND account = NEW.account
            AND asset = NEW.asset
            AND fingerprint_suffix = NEW.fingerprint_suffix
            AND status = 'open'
        )
      BEGIN SELECT RAISE(ABORT, 'fingerprint_suffix already in use on this account/asset'); END;
    CREATE TRIGGER expectations_fingerprint_update
      BEFORE UPDATE ON expectations
      WHEN NEW.fingerprint_suffix IS NOT NULL AND NEW.status = 'open'
        AND (NEW.fingerprint_suffix IS NOT OLD.fingerprint_suffix
             OR NEW.status IS NOT OLD.status)
        AND EXISTS (
          SELECT 1 FROM expectations
          WHERE tenant_id = NEW.tenant_id
            AND account = NEW.account
            AND asset = NEW.asset
            AND fingerprint_suffix = NEW.fingerprint_suffix
            AND status = 'open'
            AND id <> NEW.id
        )
      BEGIN SELECT RAISE(ABORT, 'fingerprint_suffix already in use on this account/asset'); END;
  `,
  `
    CREATE TABLE saved_journal_lines AS SELECT * FROM journal_lines;
    DROP TABLE journal_lines;
    CREATE TABLE journal_entries_current (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      tenant_id    TEXT NOT NULL,
      movement_id  TEXT REFERENCES movements (id),
      posting_no   INTEGER CHECK (posting_no >= 1),
      kind         TEXT NOT NULL CHECK (kind IN (${CURRENT_ENTRY_KINDS})),
      effective_at INTEGER NOT NULL,
      posted_at    INTEGER NOT NULL,
      description  TEXT NOT NULL,
      CHECK ((movement_id IS NULL) = (posting_no IS NULL)),
      UNIQUE (movement_id, posting_no)
    );
    INSERT INTO journal_entries_current SELECT * FROM journal_entries;
    DROP TABLE journal_entries;
    ALTER TABLE journal_entries_current RENAME TO journal_entries;
    CREATE INDEX journal_entries_effective ON journal_entries (tenant_id, effective_at);
    CREATE INDEX journal_entries_movement ON journal_entries (tenant_id, movement_id, seq);
    ${appendOnly('journal_entries')}
    CREATE TABLE journal_lines (
      entry_id       TEXT NOT NULL REFERENCES journal_entries (id),
      line_no        INTEGER NOT NULL CHECK (line_no >= 1),
      tenant_id      TEXT NOT NULL,
      account        TEXT NOT NULL,
      role           TEXT NOT NULL CHECK (role IN (${CURRENT_LINE_ROLES})),
      side           TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
      asset          TEXT NOT NULL,
      decimals       INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount         TEXT NOT NULL ${positive('amount')},
      expectation_id TEXT REFERENCES expectations (id),
      exception_id   TEXT REFERENCES exceptions (id),
      PRIMARY KEY (entry_id, line_no)
    );
    INSERT INTO journal_lines SELECT * FROM saved_journal_lines;
    DROP TABLE saved_journal_lines;
    CREATE INDEX journal_lines_account ON journal_lines (tenant_id, account, asset);
    ${appendOnly('journal_lines')}
  `,
  `
    CREATE TABLE account_openings (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      network       TEXT NOT NULL,
      account       TEXT NOT NULL,
      ledger        INTEGER NOT NULL CHECK (ledger >= 1),
      occurred_at   INTEGER NOT NULL,
      balances_json TEXT NOT NULL,
      note          TEXT,
      created_at    INTEGER NOT NULL,
      UNIQUE (tenant_id, network, account)
    );
    CREATE INDEX account_openings_tenant ON account_openings (tenant_id, network, account);
  `,
  `
    ALTER TABLE movements ADD COLUMN entity_id TEXT;
    CREATE INDEX movements_entity ON movements (tenant_id, entity_id, seq);
    ALTER TABLE journal_lines ADD COLUMN entity_id TEXT;
    CREATE INDEX journal_lines_entity ON journal_lines (tenant_id, entity_id, entry_id);
    CREATE TABLE entities (
      id          TEXT NOT NULL,
      tenant_id   TEXT NOT NULL,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE account_entities (
      tenant_id   TEXT NOT NULL,
      network     TEXT NOT NULL,
      account     TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, network, account)
    );
    CREATE INDEX account_entities_entity ON account_entities (tenant_id, entity_id);
    CREATE TABLE internal_transfer_links (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      network        TEXT NOT NULL,
      tx_hash        TEXT NOT NULL,
      movement_a     TEXT NOT NULL REFERENCES movements (id),
      movement_b     TEXT NOT NULL REFERENCES movements (id),
      same_entity    INTEGER NOT NULL CHECK (same_entity IN (0, 1)),
      created_at     INTEGER NOT NULL,
      CHECK (movement_a <> movement_b),
      UNIQUE (tenant_id, network, tx_hash, movement_a, movement_b)
    );
    CREATE TRIGGER internal_transfer_movement_a_unique
      BEFORE INSERT ON internal_transfer_links
      WHEN EXISTS (
        SELECT 1 FROM internal_transfer_links
        WHERE tenant_id = NEW.tenant_id
          AND (movement_a IN (NEW.movement_a, NEW.movement_b)
            OR movement_b IN (NEW.movement_a, NEW.movement_b))
      )
      BEGIN SELECT RAISE(ABORT, 'a movement is already part of another internal transfer'); END;
  `,
  `
    CREATE TABLE api_keys (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      label        TEXT NOT NULL,
      digest       TEXT NOT NULL UNIQUE CHECK (length(digest) = 64),
      scopes       TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      revoked_at   INTEGER,
      last_used_at INTEGER
    );
    CREATE INDEX api_keys_tenant ON api_keys (tenant_id, created_at);

    CREATE TABLE watched_accounts (
      tenant_id TEXT NOT NULL,
      account   TEXT NOT NULL,
      source    TEXT NOT NULL CHECK (source IN ('config', 'api')),
      added_at  INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, account)
    );

    CREATE TABLE sync_state (
      tenant_id       TEXT NOT NULL,
      network         TEXT NOT NULL,
      source          TEXT NOT NULL,
      account         TEXT NOT NULL,
      cursor          TEXT,
      last_attempt_at INTEGER NOT NULL,
      last_success_at INTEGER,
      caught_up       INTEGER NOT NULL CHECK (caught_up IN (0, 1)),
      last_error      TEXT,
      last_error_at   INTEGER,
      PRIMARY KEY (tenant_id, network, source, account)
    );
  `,
  `
    ALTER TABLE allocations ADD COLUMN decision TEXT CHECK (decision IS NULL OR json_valid(decision));

    CREATE TABLE decisions (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      movement_id TEXT NOT NULL UNIQUE REFERENCES movements (id),
      decided_at  INTEGER NOT NULL,
      snapshot    TEXT NOT NULL CHECK (json_valid(snapshot)),
      UNIQUE (tenant_id, movement_id)
    );
    CREATE INDEX decisions_range ON decisions (tenant_id, decided_at, seq);
  `,
  `
    CREATE TABLE schedules (
      id                TEXT NOT NULL PRIMARY KEY,
      tenant_id         TEXT NOT NULL,
      reference_pattern TEXT NOT NULL,
      account           TEXT NOT NULL,
      direction         TEXT NOT NULL CHECK (direction IN (${DIRECTIONS})),
      asset             TEXT NOT NULL,
      decimals          INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 38),
      amount            TEXT NOT NULL ${positive('amount')},
      memo_type         TEXT CHECK (memo_type IN (${MEMO_TYPES})),
      memo_value        TEXT,
      memo_text         BLOB,
      payers            TEXT NOT NULL CHECK (json_valid(payers)),
      cadence           TEXT NOT NULL CHECK (json_valid(cadence)),
      start_at          INTEGER NOT NULL,
      end_at            INTEGER,
      ended_at          INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX schedules_tenant ON schedules (tenant_id, ended_at, start_at);
  `,
]
