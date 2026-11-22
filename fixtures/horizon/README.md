# Horizon fixtures

Real Horizon responses, used by the normaliser tests so they run against what Horizon actually
returns rather than what we assume it returns.

Each file under `pubnet/` holds one operation (fetched with `?join=transactions`) and all of its
effects, with `_links` removed and nothing else changed. `sources` lists the exact URLs and
`capturedAt` the time of capture. `transactions-for-fees.json` holds three transaction records: a
normal one, a fee-bump, and a failed fee-bump, which still pays its fee.

To record a new fixture, find its operation id and run:

```bash
pnpm build
node scripts/record-fixture.mjs <operation-id> --scenario <name> [--testnet]
```

The recorder uses the public Horizon by default and testnet with `--testnet`, follows every page of
the operation's effects, and writes `pubnet/<name>.json` (or `testnet/<name>.json` with `--testnet`).
It refuses to overwrite an existing file. `sources` lists the operation URL and the URL of each
effects page fetched. The scenario name is kebab-case. `FixtureSource` in `nostro-testkit` replays
any of these files through the normaliser in tests.

These are public ledger records. A real clawback is kept under `testnet/`. Scenarios that could not
be found live in reasonable time (a CAP-73 account-creating SAC transfer, a pool trade from an
offer) are built in the tests by editing one of these records, and the tests say so.
