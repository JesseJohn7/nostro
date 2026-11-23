/**
 * Everything nostro knows about one movement, in the wire format the HTTP API
 * returns from `GET /v1/movements/:id`. The server and the CLI's `show` both
 * use this, so the two cannot drift apart.
 */
import type { Movement } from '../model/index.js'
import { allocationJson, exceptionJson, journalEntryJson, movementJson, refundLinkJson } from '../model/json.js'
import type { StoreReader } from '../store/index.js'

export interface MovementDetailOptions {
  readonly store: StoreReader
  readonly tenantId: string
  readonly movement: Movement
}

export async function movementDetail({ store, tenantId, movement }: MovementDetailOptions) {
  const movementId = movement.id
  return {
    movement: movementJson(movement),
    refunds: (await store.listRefundLinks({ tenantId, movementIds: [movementId] })).map(refundLinkJson),
    allocations: (await store.listAllocations({ tenantId, movementId })).map(allocationJson),
    exceptions: (await store.listExceptions({ tenantId, movementId })).map(exceptionJson),
    journal: (await store.listJournalEntries({ tenantId, movementId })).map(journalEntryJson),
    decision: (await store.getDecision(tenantId, movementId))?.snapshot ?? null,
  }
}
