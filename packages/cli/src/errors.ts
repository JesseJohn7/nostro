/** Errors shared by the argument parser, the config loader and the command runner. */

/** The command line was wrong. Exit status 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * Stable reasons a command can fail with, for scripts reading `--json` errors.
 * Adding a code is not breaking; renaming or removing one is.
 */
export type ErrorCode = 'usage' | 'no_database' | 'schema_mismatch' | 'horizon' | 'failed' | 'internal'

/** The command could not do what was asked, for a reason the message explains. Exit status 1. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'failed',
  ) {
    super(message)
    this.name = 'CliError'
  }
}
