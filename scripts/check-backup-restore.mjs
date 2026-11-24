#!/usr/bin/env node
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStore } from '../packages/store-sqlite/dist/index.js'

const dir = mkdtempSync(join(tmpdir(), 'nostro-backup-'))
const source = join(dir, 'source.db')
const backup = join(dir, 'backup.db')
try {
  const original = new SqliteStore({ filename: source })
  await original.migrate()
  await original.close()
  copyFileSync(source, backup)
  const restored = new SqliteStore({ filename: backup })
  const version = await restored.schemaVersion()
  if (version.current !== version.latest) throw new Error('restored database schema is not current')
  await restored.close()
  console.log('backup and restore: OK')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
