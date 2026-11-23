# @nostro-labs/store-conformance

The [Store contract](https://github.com/nostro-labs/nostro/blob/main/docs/stores.md) as executable
tests. Every store backend — memory, SQLite, PostgreSQL — runs the same suites, so a rule enforced in
one store with code and in another with constraints and locks is checked everywhere.

```sh
npm install --save-dev @nostro-labs/store-conformance vitest
```

```ts
import { STORE_CONTRACT_VERSION, describeStoreConformance, describeStoreProperties } from '@nostro-labs/store-conformance'
import { MemoryStore } from '@nostro-labs/nostro'

describeStoreConformance('MemoryStore', () => new MemoryStore(), { contractVersion: STORE_CONTRACT_VERSION })
describeStoreProperties('MemoryStore', (now) => new MemoryStore({ now }), {
  contractVersion: STORE_CONTRACT_VERSION,
  runs: 200,
})
```

`describeStoreConformance` also registers `describeJournalConformance` and `describeRefundConformance`;
call them separately only when testing a partial implementation. Each suite takes a store factory
(called before every test) and requires `contractVersion`, usually `STORE_CONTRACT_VERSION` from
`@nostro-labs/nostro`. A different major version throws before any test is registered.

`describeStoreProperties` generates random but valid payment histories with `fast-check`, checks the
records themselves after each one, and can compare every decision with `MemoryStore` via
`differential: true`. `NOSTRO_PROPERTY_RUNS` overrides `runs` for a longer manual run. Property tests
are slow; keep them in the store's own test suite, not in the library's unit tests.

The property helpers (`scenario`, `runScenario`, `checkBooks`, `snapshot`, `parseCsv`,
`SCENARIO_ACCOUNT`, `SCENARIO_NOW`) are exported for store-specific tests that need the same facts and
the same hostile text. `FakeHorizon`, `hash`, `toid` and `FixtureSource` stay private to
`nostro-testkit`.

**Status:** 0.1.0, early: the suites cover the published Store contract, but the API may change before
1.0. See [docs/stores.md](https://github.com/nostro-labs/nostro/blob/main/docs/stores.md) for what they
prove and what they cannot.
