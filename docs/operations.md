# Operations guide

## Safe shutdown and restart

`nostro serve` and `nostro sync` are safe to stop with `SIGTERM` or `SIGINT`.
The current pull is allowed to finish, and the cursor is committed in the same
transaction as its movements. Stop the process, then run the same command again:
it resumes from the saved cursor and the movement identity constraint makes a
replayed page harmless.

For a controlled deployment, send `SIGTERM`, wait for the process to exit with
status 0, and only then replace the container or database volume. A forced kill
may leave an unfinished transaction, but it cannot leave a partially advanced
cursor.

## SQLite backup and restore

Stop writers before copying a SQLite database. The simplest portable backup is:

```bash
nostro serve --db /var/lib/nostro/nostro.db &
PID=$!
kill -TERM "$PID"
wait "$PID"
cp --reflink=auto /var/lib/nostro/nostro.db /backups/nostro-$(date -u +%Y%m%dT%H%M%SZ).db
```

Restore by replacing the database while the service is stopped, then verify the
schema and invariants before accepting traffic:

```bash
cp /backups/nostro-20261124T120000Z.db /var/lib/nostro/nostro.db
nostro doctor --db /var/lib/nostro/nostro.db
nostro serve --db /var/lib/nostro/nostro.db
```

For PostgreSQL and MySQL, use consistent snapshot tools (`pg_dump --format=custom`
/ `pg_restore`, or `mysqldump --single-transaction`). Never copy live database
files from those servers.

CI runs `scripts/check-backup-restore.mjs` against a migrated SQLite database to
ensure a backup can be restored and opened by the current binary.
