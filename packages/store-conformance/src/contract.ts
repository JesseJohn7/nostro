import { STORE_CONTRACT_VERSION } from '@nostro-labs/nostro'

/** Options every store suite needs, so a store cannot silently test an older contract. */
export interface ConformanceOptions {
  readonly contractVersion: string
}

export function supportsContract(contractVersion: string): boolean {
  const major = (version: string) => version.split('.')[0]
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(contractVersion) && major(contractVersion) === major(STORE_CONTRACT_VERSION)
}

export function assertContractVersion(contractVersion: string): void {
  if (!supportsContract(contractVersion)) {
    throw new Error(
      `The store conformance suite for ${STORE_CONTRACT_VERSION} cannot test contract ${contractVersion}: the major version must match`,
    )
  }
}
