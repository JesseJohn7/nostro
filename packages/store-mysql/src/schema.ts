const DB_RE = /^[A-Za-z0-9_$]{1,64}$/

export function quoteSchema(schema: string): string {
  if (!DB_RE.test(schema)) {
    throw new Error(`Invalid database name ${JSON.stringify(schema)}: use letters, digits, _ and $.`)
  }
  return `\`${schema}\``
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

const ENGINE = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin ROW_FORMAT=DYNAMIC'
const T = 'VARCHAR(191)'
const TIME = 'DATETIME(6)'
const MONEY = 'DECIMAL(40, 0)'

const appendOnly = (s: string, table: string, message: string, guard = ''): string[] => {
  const condition = guard === '' ? '' : `  IF ${guard} THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}';\n  END IF;`
  const body = condition === '' ? `  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'` : condition
  return [
    `CREATE TRIGGER ${table}_append_only_u BEFORE UPDATE ON ${s}.${table}
       FOR EACH ROW BEGIN
     ${body}
       END`,
    `CREATE TRIGGER ${table}_append_only_d BEFORE DELETE ON ${s}.${table}
       FOR EACH ROW BEGIN
     ${body}
       END`,
  ]
}

export const MIGRATIONS: readonly ((s: string) => readonly string[])[] = [
  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.movements (
       id             ${T} PRIMARY KEY,
       seq            BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       tenant_id      ${T} NOT NULL,
       network        ${T} NOT NULL,
       source         ${T} NOT NULL,
       external_id    ${T} NOT NULL,
       revision       INT NOT NULL CHECK (revision >= 1),
       account        ${T} NOT NULL,
       direction      ${T} NOT NULL CONSTRAINT movements_direction_check CHECK (direction IN (${DIRECTIONS})),
       kind           ${T} NOT NULL CONSTRAINT movements_kind_check CHECK (kind IN (${KINDS})),
       asset          ${T} NOT NULL,
       decimals       SMALLINT NOT NULL CONSTRAINT movements_decimals_check CHECK (decimals BETWEEN 0 AND 38),
       amount         ${MONEY} NOT NULL CONSTRAINT movements_amount_check CHECK (amount > 0),
       counterparty   ${T},
       muxed_id       DECIMAL(20, 0),
       memo_type      ${T} CONSTRAINT movements_memo_type_check CHECK (memo_type IN (${MEMO_TYPES})),
       memo_value     ${T},
       memo_text      BLOB,
       ledger         BIGINT NOT NULL CONSTRAINT movements_ledger_check CHECK (ledger >= 1),
       tx_hash        ${T},
       operation_id   ${T},
       occurred_at    ${TIME} NOT NULL,
       enrichment     ${T} NOT NULL CONSTRAINT movements_enrichment_check CHECK (enrichment IN ('complete', 'missing')),
       disposition    ${T} NOT NULL CONSTRAINT movements_disposition_check CHECK (disposition IN (${DISPOSITIONS})),
       ignored_reason TEXT,
       created_at     ${TIME} NOT NULL,
       CONSTRAINT movements_dedupe UNIQUE (tenant_id, network, source, external_id),
       CONSTRAINT movements_ignored_reason_check CHECK ((disposition = 'ignored') = (ignored_reason IS NOT NULL))
     )${ENGINE}`,
    `CREATE INDEX movements_queue ON ${s}.movements (tenant_id, disposition, seq)`,
    `CREATE INDEX movements_account ON ${s}.movements (tenant_id, account, seq)`,

    `CREATE TABLE IF NOT EXISTS ${s}.expectations (
       id            ${T} PRIMARY KEY,
       seq           BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       tenant_id     ${T} NOT NULL,
       reference     ${T} NOT NULL,
       account       ${T} NOT NULL,
       direction     ${T} NOT NULL CONSTRAINT expectations_direction_check CHECK (direction IN (${DIRECTIONS})),
       asset         ${T} NOT NULL,
       decimals      SMALLINT NOT NULL CONSTRAINT expectations_decimals_check CHECK (decimals BETWEEN 0 AND 38),
       amount        ${MONEY} NOT NULL CONSTRAINT expectations_amount_check CHECK (amount > 0),
       muxed_id      DECIMAL(20, 0),
       memo_type     ${T} CONSTRAINT expectations_memo_type_check CHECK (memo_type IN (${MEMO_TYPES})),
       memo_value    ${T},
       memo_text     BLOB,
       payers        LONGTEXT NOT NULL,
       due_at        ${TIME},
       expires_at    ${TIME},
       status        ${T} NOT NULL CONSTRAINT expectations_status_check CHECK (status IN (${EXPECTATION_STATUSES})),
       cancel_reason TEXT,
       metadata      LONGTEXT NOT NULL,
       created_at    ${TIME} NOT NULL,
       updated_at    ${TIME} NOT NULL,
       CONSTRAINT expectations_reference_unique UNIQUE (tenant_id, reference)
     )${ENGINE}`,
    `CREATE INDEX expectations_candidates ON ${s}.expectations (tenant_id, account, asset, status)`,
    `CREATE INDEX expectations_muxed ON ${s}.expectations (tenant_id, account, muxed_id)`,

    `CREATE TABLE IF NOT EXISTS ${s}.allocations (
       id             ${T} PRIMARY KEY,
       seq            BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       tenant_id      ${T} NOT NULL,
       movement_id    ${T} NOT NULL REFERENCES ${s}.movements (id),
       expectation_id ${T} NOT NULL REFERENCES ${s}.expectations (id),
       asset          ${T} NOT NULL,
       decimals       SMALLINT NOT NULL,
       amount         ${MONEY} NOT NULL CONSTRAINT allocations_amount_check CHECK (amount > 0),
       strategy       ${T} NOT NULL,
       score          DOUBLE CHECK (score BETWEEN 0 AND 1),
       created_at     ${TIME} NOT NULL,
       CONSTRAINT allocations_unique UNIQUE (movement_id, expectation_id)
     )${ENGINE}`,
    `CREATE INDEX allocations_expectation ON ${s}.allocations (expectation_id)`,
    `CREATE INDEX allocations_tenant ON ${s}.allocations (tenant_id, movement_id)`,

    `CREATE TABLE IF NOT EXISTS ${s}.exceptions (
       id              ${T} PRIMARY KEY,
       seq             BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       tenant_id       ${T} NOT NULL,
       code            ${T} NOT NULL CONSTRAINT exceptions_code_check CHECK (code IN (${EXCEPTION_CODES})),
       status          ${T} NOT NULL CONSTRAINT exceptions_status_check CHECK (status IN (${EXCEPTION_STATUSES})),
       movement_id     ${T} REFERENCES ${s}.movements (id),
       expectation_id  ${T} REFERENCES ${s}.expectations (id),
       account         ${T},
       asset           ${T},
       decimals        SMALLINT,
       amount          ${MONEY},
       detail          TEXT NOT NULL,
       evidence        LONGTEXT NOT NULL,
       opened_at       ${TIME} NOT NULL,
       resolved_at     ${TIME},
       resolution_note TEXT,
       CONSTRAINT exceptions_subject_check CHECK (movement_id IS NOT NULL OR expectation_id IS NOT NULL OR account IS NOT NULL),
       CONSTRAINT exceptions_amount_check CHECK ((amount IS NULL) = (asset IS NULL) AND (asset IS NULL) = (decimals IS NULL))
     )${ENGINE}`,
    `CREATE INDEX exceptions_queue ON ${s}.exceptions (tenant_id, status, code)`,
    `CREATE INDEX exceptions_movement ON ${s}.exceptions (movement_id)`,

    `CREATE TABLE IF NOT EXISTS ${s}.cursors (
       tenant_id ${T} NOT NULL,
       network   ${T} NOT NULL,
       source    ${T} NOT NULL,
       account   ${T} NOT NULL,
       value     ${T},
       PRIMARY KEY (tenant_id, network, source, account)
     )${ENGINE}`,

    `CREATE TABLE IF NOT EXISTS ${s}.event_locks (
       lock_key ${T} NOT NULL PRIMARY KEY
     )${ENGINE}`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.journal_entries (
       id           ${T} PRIMARY KEY,
       seq          BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       tenant_id    ${T} NOT NULL,
       movement_id  ${T} REFERENCES ${s}.movements (id),
       posting_no   INT CONSTRAINT journal_entries_posting_check CHECK (posting_no >= 1),
       kind         ${T} NOT NULL CONSTRAINT journal_entries_kind_check CHECK (kind IN (${ENTRY_KINDS})),
       effective_at ${TIME} NOT NULL,
       posted_at    ${TIME} NOT NULL,
       description  TEXT NOT NULL,
       CONSTRAINT journal_entries_posting_unique UNIQUE (movement_id, posting_no),
       CONSTRAINT journal_entries_posting_pair_check CHECK ((movement_id IS NULL) = (posting_no IS NULL))
     )${ENGINE}`,
    `CREATE INDEX journal_entries_effective ON ${s}.journal_entries (tenant_id, effective_at)`,

    `CREATE TABLE IF NOT EXISTS ${s}.journal_lines (
       entry_id       ${T} NOT NULL REFERENCES ${s}.journal_entries (id),
       line_no        SMALLINT NOT NULL CONSTRAINT journal_lines_line_no_check CHECK (line_no >= 1),
       tenant_id      ${T} NOT NULL,
       account        ${T} NOT NULL,
       role           ${T} NOT NULL CONSTRAINT journal_lines_role_check CHECK (role IN (${LINE_ROLES})),
       side           ${T} NOT NULL CONSTRAINT journal_lines_side_check CHECK (side IN ('debit', 'credit')),
       asset          ${T} NOT NULL,
       decimals       SMALLINT NOT NULL CONSTRAINT journal_lines_decimals_check CHECK (decimals BETWEEN 0 AND 38),
       amount         ${MONEY} NOT NULL CONSTRAINT journal_lines_amount_check CHECK (amount > 0),
       expectation_id ${T} REFERENCES ${s}.expectations (id),
       exception_id   ${T} REFERENCES ${s}.exceptions (id),
       PRIMARY KEY (entry_id, line_no)
     )${ENGINE}`,
    `CREATE INDEX journal_lines_account ON ${s}.journal_lines (tenant_id, account, asset)`,
    ...appendOnly(s, 'journal_entries', 'the journal is append-only'),
    ...appendOnly(s, 'journal_lines', 'the journal is append-only'),
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.events (
       seq        BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       id         ${T} PRIMARY KEY,
       tenant_id  ${T} NOT NULL,
       type       ${T} NOT NULL CONSTRAINT events_type_check CHECK (type IN (${EVENT_TYPES})),
       subject_id ${T} NOT NULL,
       payload    LONGTEXT NOT NULL,
       created_at ${TIME} NOT NULL
     )${ENGINE}`,
    `CREATE INDEX events_tenant ON ${s}.events (tenant_id, seq)`,
    ...appendOnly(s, 'events', 'the event log is append-only'),
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.journal_period_actions (
       seq            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       tenant_id      ${T} NOT NULL,
       action         ${T} NOT NULL CONSTRAINT journal_period_actions_action_check CHECK (action IN ('close', 'reopen')),
       closed_through ${TIME},
       note           TEXT,
       reason         TEXT,
       created_at     ${TIME} NOT NULL,
       CONSTRAINT journal_period_actions_shape_check CHECK (
         (action = 'close' AND closed_through IS NOT NULL AND reason IS NULL) OR
         (action = 'reopen' AND closed_through IS NULL AND note IS NULL AND reason IS NOT NULL)
       )
     )${ENGINE}`,
    `CREATE INDEX journal_period_actions_tenant ON ${s}.journal_period_actions (tenant_id, seq)`,
    ...appendOnly(s, 'journal_period_actions', 'journal period actions are append-only'),
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.expectation_reference_index (
       tenant_id      ${T} NOT NULL,
       normalized     ${T} NOT NULL,
       expectation_id ${T} NOT NULL REFERENCES ${s}.expectations (id),
       PRIMARY KEY (tenant_id, normalized, expectation_id)
     )${ENGINE}`,
    `CREATE INDEX expectation_reference_keys ON ${s}.expectation_reference_index (tenant_id, normalized)`,
  ],

  (s) => [
    `ALTER TABLE ${s}.exceptions DROP CHECK exceptions_code_check`,
    `ALTER TABLE ${s}.exceptions ADD CONSTRAINT exceptions_code_check CHECK (code IN (${EXCEPTION_CODES}))`,
    `ALTER TABLE ${s}.events DROP CHECK events_type_check`,
    `ALTER TABLE ${s}.events ADD CONSTRAINT events_type_check CHECK (type IN (${EVENT_TYPES}))`,
    `ALTER TABLE ${s}.exceptions ADD COLUMN expired_expectation ${T}
       GENERATED ALWAYS AS (CASE WHEN code = 'EXPECTATION_EXPIRED' THEN expectation_id END) STORED`,
    `CREATE UNIQUE INDEX exceptions_expiry_once ON ${s}.exceptions (tenant_id, expired_expectation)`,
    `CREATE TRIGGER expectations_muxed_id_insert_unique BEFORE INSERT ON ${s}.expectations
       FOR EACH ROW BEGIN
         IF NEW.muxed_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM ${s}.expectations e
            WHERE e.tenant_id = NEW.tenant_id AND e.account = NEW.account
              AND e.muxed_id = NEW.muxed_id AND e.id <> NEW.id
         ) THEN
           SIGNAL SQLSTATE '23000' SET MESSAGE_TEXT = 'expectation_muxed_id_unique: muxed id already used on account', MYSQL_ERRNO = 1062;
         END IF;
       END`,
    `CREATE TRIGGER expectations_muxed_id_update_unique BEFORE UPDATE ON ${s}.expectations
       FOR EACH ROW BEGIN
         IF NEW.muxed_id <=> OLD.muxed_id THEN
           SET NEW.muxed_id = OLD.muxed_id;
         ELSEIF NEW.muxed_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM ${s}.expectations e
            WHERE e.tenant_id = NEW.tenant_id AND e.account = NEW.account
              AND e.muxed_id = NEW.muxed_id AND e.id <> NEW.id
         ) THEN
           SIGNAL SQLSTATE '23000' SET MESSAGE_TEXT = 'expectation_muxed_id_unique: muxed id already used on account', MYSQL_ERRNO = 1062;
         END IF;
       END`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.exports (
       tenant_id        ${T} NOT NULL,
       destination      ${T} NOT NULL,
       last_seq         BIGINT NOT NULL DEFAULT 0,
       last_exported_at ${TIME} NOT NULL,
       control_totals   LONGTEXT NOT NULL,
        checksum         LONGTEXT NOT NULL,
       PRIMARY KEY (tenant_id, destination)
     )${ENGINE}`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.accrual_modes (
       tenant_id ${T} NOT NULL PRIMARY KEY,
       active    TINYINT(1) NOT NULL DEFAULT 0
     )${ENGINE}`,
  ],

  (s) => [
    `CREATE INDEX exceptions_expectation ON ${s}.exceptions (tenant_id, expectation_id)`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.event_prune_state (
       tenant_id      ${T} NOT NULL PRIMARY KEY,
       pruned_through BIGINT NOT NULL DEFAULT 0 CONSTRAINT event_prune_state_through_check CHECK (pruned_through >= 0)
     )${ENGINE}`,
    `DROP TRIGGER IF EXISTS ${s}.events_append_only_d`,
    `CREATE TRIGGER events_append_only_d BEFORE DELETE ON ${s}.events
       FOR EACH ROW BEGIN
         IF COALESCE(@nostro_event_prune, 'off') <> 'on' THEN
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the event log is append-only';
         END IF;
       END`,
  ],

  (s) => [
    `ALTER TABLE ${s}.journal_entries DROP CHECK journal_entries_kind_check`,
    `ALTER TABLE ${s}.journal_entries ADD CONSTRAINT journal_entries_kind_check CHECK (kind IN (${MANUAL_ENTRY_KINDS}))`,
    `ALTER TABLE ${s}.journal_lines DROP CHECK journal_lines_role_check`,
    `ALTER TABLE ${s}.journal_lines ADD CONSTRAINT journal_lines_role_check CHECK (role IN (${LINE_ROLES}, 'other'))`,
    `CREATE TABLE IF NOT EXISTS ${s}.movement_valuations (
       tenant_id       ${T} NOT NULL,
       movement_id     ${T} NOT NULL REFERENCES ${s}.movements (id),
       reporting_asset ${T} NOT NULL,
       price_n         ${MONEY} NOT NULL,
       price_d         ${MONEY} NOT NULL,
       price_source    ${T} NOT NULL,
       price_timestamp ${TIME} NOT NULL,
       decimals        SMALLINT NOT NULL CONSTRAINT movement_valuations_decimals_check CHECK (decimals BETWEEN 0 AND 38),
       value           ${MONEY} NOT NULL,
       valued_at       ${TIME} NOT NULL,
       PRIMARY KEY (tenant_id, movement_id)
     )${ENGINE}`,
    `CREATE INDEX movement_valuations_reporting ON ${s}.movement_valuations (tenant_id, reporting_asset)`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.refund_links (
       seq               BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       id                ${T} PRIMARY KEY,
       tenant_id         ${T} NOT NULL,
       credit_movement_id ${T} NOT NULL REFERENCES ${s}.movements (id),
       refund_movement_id ${T} NOT NULL UNIQUE REFERENCES ${s}.movements (id),
       asset             ${T} NOT NULL,
       decimals          SMALLINT NOT NULL CONSTRAINT refund_links_decimals_check CHECK (decimals BETWEEN 0 AND 38),
       amount            ${MONEY} NOT NULL CONSTRAINT refund_links_amount_check CHECK (amount > 0),
       residual_amount   ${MONEY} NOT NULL CONSTRAINT refund_links_residual_check CHECK (residual_amount >= 0 AND residual_amount <= amount),
       created_at        ${TIME} NOT NULL
     )${ENGINE}`,
    `CREATE INDEX refund_credit ON ${s}.refund_links (tenant_id, credit_movement_id, seq)`,
    `CREATE INDEX movements_transaction ON ${s}.movements (tenant_id, account, tx_hash)`,
    `CREATE TRIGGER refund_links_append_only_u BEFORE UPDATE ON ${s}.refund_links
       FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the journal is append-only'`,
    `CREATE TRIGGER refund_links_append_only_d BEFORE DELETE ON ${s}.refund_links
       FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the journal is append-only'`,
    `ALTER TABLE ${s}.journal_lines DROP CHECK journal_lines_role_check`,
    `ALTER TABLE ${s}.journal_lines ADD CONSTRAINT journal_lines_role_check CHECK (role IN (${LINE_ROLES}, 'other', 'refund_clearing'))`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.webhook_delivery_attempts (
       seq         BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       id          ${T} PRIMARY KEY,
       tenant_id   ${T} NOT NULL,
       consumer    ${T} NOT NULL,
       event_id    ${T} NOT NULL,
       event_seq   BIGINT NOT NULL CONSTRAINT webhook_delivery_attempts_event_seq_check CHECK (event_seq >= 0),
       attempt_at  ${TIME} NOT NULL,
       http_status INT,
       error       TEXT,
       duration_ms INT NOT NULL CONSTRAINT webhook_delivery_attempts_duration_check CHECK (duration_ms >= 0),
       outcome     ${T} NOT NULL CONSTRAINT webhook_delivery_attempts_outcome_check CHECK (outcome IN ('success', 'failure')),
       CONSTRAINT webhook_delivery_attempts_status_check CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
     )${ENGINE}`,
    `CREATE INDEX webhook_attempts_consumer ON ${s}.webhook_delivery_attempts (tenant_id, consumer, seq DESC)`,
    `CREATE INDEX webhook_attempts_age ON ${s}.webhook_delivery_attempts (tenant_id, consumer, attempt_at)`,

    `CREATE TABLE IF NOT EXISTS ${s}.webhook_rewinds (
       seq       BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
       id        ${T} PRIMARY KEY,
       tenant_id ${T} NOT NULL,
       consumer  ${T} NOT NULL,
       from_seq  BIGINT NOT NULL CONSTRAINT webhook_rewinds_from_check CHECK (from_seq >= 0),
       to_seq    BIGINT NOT NULL CONSTRAINT webhook_rewinds_to_check CHECK (to_seq >= 0),
       actor     ${T} NOT NULL,
       at        ${TIME} NOT NULL,
       CONSTRAINT webhook_rewinds_direction_check CHECK (to_seq < from_seq)
     )${ENGINE}`,
    `CREATE INDEX webhook_rewinds_consumer ON ${s}.webhook_rewinds (tenant_id, consumer, seq DESC)`,
  ],

  (s) => [
    `ALTER TABLE ${s}.expectations ADD COLUMN fingerprint_suffix ${MONEY}
       CONSTRAINT expectations_fingerprint_positive CHECK (fingerprint_suffix > 0)`,
    `ALTER TABLE ${s}.expectations ADD COLUMN open_fingerprint ${MONEY}
       GENERATED ALWAYS AS (CASE WHEN status = 'open' THEN fingerprint_suffix END) STORED`,
    `CREATE UNIQUE INDEX expectations_fingerprint ON ${s}.expectations (tenant_id, account, asset, open_fingerprint)`,
  ],

  (s) => [
    `ALTER TABLE ${s}.journal_entries DROP CHECK journal_entries_kind_check`,
    `ALTER TABLE ${s}.journal_entries ADD CONSTRAINT journal_entries_kind_check CHECK (kind IN (${CURRENT_ENTRY_KINDS}))`,
    `ALTER TABLE ${s}.journal_lines DROP CHECK journal_lines_role_check`,
    `ALTER TABLE ${s}.journal_lines ADD CONSTRAINT journal_lines_role_check CHECK (role IN (${CURRENT_LINE_ROLES}))`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.account_openings (
       id          ${T} PRIMARY KEY,
       tenant_id   ${T} NOT NULL,
       network     ${T} NOT NULL,
       account     ${T} NOT NULL,
       ledger      BIGINT NOT NULL CONSTRAINT account_openings_ledger_check CHECK (ledger >= 1),
       occurred_at ${TIME} NOT NULL,
       balances_json LONGTEXT NOT NULL,
       note        TEXT,
       created_at  ${TIME} NOT NULL,
       UNIQUE (tenant_id, network, account)
     )${ENGINE}`,
    `CREATE INDEX account_openings_tenant ON ${s}.account_openings (tenant_id, network, account)`,
  ],

  (s) => [
    `ALTER TABLE ${s}.movements ADD COLUMN entity_id ${T}`,
    `CREATE INDEX movements_entity ON ${s}.movements (tenant_id, entity_id, seq)`,
    `ALTER TABLE ${s}.journal_lines ADD COLUMN entity_id ${T}`,
    `CREATE INDEX journal_lines_entity ON ${s}.journal_lines (tenant_id, entity_id, entry_id)`,

    `CREATE TABLE IF NOT EXISTS ${s}.entities (
       id         ${T} NOT NULL,
       tenant_id  ${T} NOT NULL,
       name       ${T} NOT NULL,
       created_at ${TIME} NOT NULL,
       PRIMARY KEY (tenant_id, id)
     )${ENGINE}`,

    `CREATE TABLE IF NOT EXISTS ${s}.account_entities (
       tenant_id  ${T} NOT NULL,
       network    ${T} NOT NULL,
       account    ${T} NOT NULL,
       entity_id  ${T} NOT NULL,
       created_at ${TIME} NOT NULL,
       PRIMARY KEY (tenant_id, network, account)
     )${ENGINE}`,
    `CREATE INDEX account_entities_entity ON ${s}.account_entities (tenant_id, entity_id)`,

    `CREATE TABLE IF NOT EXISTS ${s}.internal_transfer_links (
       id          ${T} PRIMARY KEY,
       tenant_id   ${T} NOT NULL,
       network     ${T} NOT NULL,
       tx_hash     ${T} NOT NULL,
       movement_a  ${T} NOT NULL REFERENCES ${s}.movements (id),
       movement_b  ${T} NOT NULL REFERENCES ${s}.movements (id),
       same_entity TINYINT(1) NOT NULL,
       created_at  ${TIME} NOT NULL,
       CONSTRAINT internal_transfer_movements_check CHECK (movement_a <> movement_b),
       UNIQUE (tenant_id, network, tx_hash, movement_a, movement_b)
     )${ENGINE}`,
    `CREATE TRIGGER internal_transfer_unique_movement BEFORE INSERT ON ${s}.internal_transfer_links
       FOR EACH ROW BEGIN
         IF EXISTS (
           SELECT 1 FROM ${s}.internal_transfer_links l
            WHERE l.tenant_id = NEW.tenant_id
              AND (l.movement_a IN (NEW.movement_a, NEW.movement_b)
                OR l.movement_b IN (NEW.movement_a, NEW.movement_b))
         ) THEN
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a movement is already part of another internal transfer';
         END IF;
       END`,
  ],

  (s) => [
    `CREATE TABLE IF NOT EXISTS ${s}.api_keys (
       id           ${T} PRIMARY KEY,
       tenant_id    ${T} NOT NULL,
       label        TEXT NOT NULL,
       digest       CHAR(64) NOT NULL CONSTRAINT api_keys_digest_unique UNIQUE,
       scopes       LONGTEXT NOT NULL,
       created_at   ${TIME} NOT NULL,
       revoked_at   ${TIME},
       last_used_at ${TIME}
     )${ENGINE}`,
    `CREATE INDEX api_keys_tenant ON ${s}.api_keys (tenant_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS ${s}.watched_accounts (
       tenant_id ${T} NOT NULL,
       account   ${T} NOT NULL,
       source    ${T} NOT NULL CONSTRAINT watched_accounts_source_check CHECK (source IN ('config', 'api')),
       added_at  ${TIME} NOT NULL,
       PRIMARY KEY (tenant_id, account)
     )${ENGINE}`,

    `CREATE TABLE IF NOT EXISTS ${s}.sync_state (
       tenant_id       ${T} NOT NULL,
       network         ${T} NOT NULL,
       source          ${T} NOT NULL,
       account         ${T} NOT NULL,
        \`cursor\`      ${T},
       last_attempt_at ${TIME} NOT NULL,
       last_success_at ${TIME},
       caught_up       TINYINT(1) NOT NULL,
       last_error      TEXT,
       last_error_at   ${TIME},
        PRIMARY KEY (tenant_id, network, source, account)
      )${ENGINE}`,
   ],

   (s) => [
     `ALTER TABLE ${s}.allocations ADD COLUMN decision LONGTEXT`,
     `CREATE TABLE IF NOT EXISTS ${s}.decisions (
        seq         BIGINT NOT NULL AUTO_INCREMENT UNIQUE KEY,
        tenant_id   ${T} NOT NULL,
        movement_id ${T} NOT NULL REFERENCES ${s}.movements (id),
        decided_at  ${TIME} NOT NULL,
        snapshot    LONGTEXT NOT NULL,
        CONSTRAINT decisions_unique UNIQUE (tenant_id, movement_id)
      )${ENGINE}`,
     `CREATE INDEX decisions_range ON ${s}.decisions (tenant_id, decided_at, seq)`,
     `CREATE TABLE IF NOT EXISTS ${s}.schedules (
        id                ${T} PRIMARY KEY,
        tenant_id         ${T} NOT NULL,
        reference_pattern ${T} NOT NULL,
        account           ${T} NOT NULL,
        direction         ${T} NOT NULL CONSTRAINT schedules_direction_check CHECK (direction IN (${DIRECTIONS})),
        asset             ${T} NOT NULL,
        decimals          SMALLINT NOT NULL CONSTRAINT schedules_decimals_check CHECK (decimals BETWEEN 0 AND 38),
        amount            ${MONEY} NOT NULL CONSTRAINT schedules_amount_check CHECK (amount > 0),
        memo_type         ${T} CONSTRAINT schedules_memo_type_check CHECK (memo_type IN (${MEMO_TYPES})),
        memo_value        ${T},
        memo_text         BLOB,
        payers            LONGTEXT NOT NULL,
        cadence           LONGTEXT NOT NULL,
        start_at          ${TIME} NOT NULL,
        end_at            ${TIME},
        ended_at          ${TIME},
        created_at        ${TIME} NOT NULL,
        updated_at        ${TIME} NOT NULL
      )${ENGINE}`,
     `CREATE INDEX schedules_tenant ON ${s}.schedules (tenant_id, ended_at, start_at)`,
   ],
]
