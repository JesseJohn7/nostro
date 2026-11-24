# nostro with Docker Compose

PostgreSQL, `nostro migrate` (once), `nostro serve`, and a webhook receiver that verifies every
request's signature with `verifyWebhook()` from nostro.

```sh
cp .env.example .env    # then fill it in: openssl rand -hex 32 for each secret
docker compose up -d --build
docker compose logs -f receiver
```

With `NOSTRO_ACCOUNTS` set to a testnet account, `serve` syncs and reconciles it every 30 seconds,
and each decision arrives at the receiver as a signed event:

```
receiver-1  | verified movement.decided 2f6c…
receiver-1  | verified exception.opened 9a1d…
```

The API listens on 127.0.0.1:8080:

```sh
curl -H "Authorization: Bearer <key>" localhost:8080/v1/exceptions
curl localhost:8080/v1/openapi.json
```

The CLI can work through that API instead of opening the database. This is useful for a person
triaging exceptions who has an API key but should not have PostgreSQL credentials:

```sh
export NOSTRO_API_KEY=<the key from .env>
nostro exceptions --api http://localhost:8080
nostro expectations --api http://localhost:8080 --json
nostro export --api http://localhost:8080 --output journal.csv
```

The key comes only from `NOSTRO_API_KEY`, never a flag, and is never printed. `expectations`,
`expect`, `exceptions`, `resolve` and CSV `export` work in remote mode with the same text and
`--json` output as local mode; lists follow the API cursor. Commands that need the database
(`migrate`, `sync`, `reconcile`, `post`, `doctor`, `serve`, and the rest) refuse with a message that
says so. API errors print their problem code, for example `nostro: resolution_refused: ...`, and
exit 1 (2 for a malformed request).

`migrate` runs before `serve` starts and is the only thing that changes the schema; run
`docker compose run --rm migrate` after upgrading the image. `docker compose down` stops
everything cleanly; add `-v` to delete the database too.
