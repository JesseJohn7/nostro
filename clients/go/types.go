package nostro

import "encoding/json"

// Common scalar aliases. Assets are full canonical strings: "native" or "CODE:ISSUER".
type Asset string

type Memo struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type Movement struct {
	ID            string          `json:"id"`
	Seq           int64           `json:"seq"`
	Network       string          `json:"network"`
	Source        string          `json:"source"`
	ExternalID    string          `json:"externalId"`
	Revision      int64           `json:"revision"`
	Account       string          `json:"account"`
	EntityID      *string         `json:"entityId"`
	Direction     string          `json:"direction"`
	Kind          string          `json:"kind"`
	Amount        string          `json:"amount"`
	Asset         Asset           `json:"asset"`
	Counterparty  *string         `json:"counterparty"`
	MuxedID       *string         `json:"muxedId"`
	Memo          *Memo           `json:"memo"`
	Ledger        int64           `json:"ledger"`
	TxHash        *string         `json:"txHash"`
	OperationID   *string         `json:"operationId"`
	OccurredAt    string          `json:"occurredAt"`
	Enrichment    string          `json:"enrichment"`
	Disposition   string          `json:"disposition"`
	IgnoredReason *string         `json:"ignoredReason"`
	CreatedAt     string          `json:"createdAt"`
	Raw           json.RawMessage `json:"-"`
}

type Expectation struct {
	ID           string            `json:"id"`
	Seq          int64             `json:"seq"`
	Reference    string            `json:"reference"`
	Account      string            `json:"account"`
	Direction    string            `json:"direction"`
	Amount       string            `json:"amount"`
	Asset        Asset             `json:"asset"`
	MuxedID      *string           `json:"muxedId"`
	Memo         *Memo             `json:"memo"`
	Payers       []string          `json:"payers"`
	DueAt        *string           `json:"dueAt"`
	ExpiresAt    *string           `json:"expiresAt"`
	Status       string            `json:"status"`
	CancelReason *string           `json:"cancelReason"`
	Metadata     map[string]string `json:"metadata"`
	CreatedAt    string            `json:"createdAt"`
	UpdatedAt    string            `json:"updatedAt"`
}

type Allocation struct {
	ID            string          `json:"id"`
	MovementID    string          `json:"movementId"`
	ExpectationID string          `json:"expectationId"`
	Amount        string          `json:"amount"`
	Asset         Asset           `json:"asset"`
	Strategy      string          `json:"strategy"`
	Score         *json.Number    `json:"score"`
	Decision      json.RawMessage `json:"decision"`
	CreatedAt     string          `json:"createdAt"`
}

type Exception struct {
	ID             string          `json:"id"`
	Seq            int64           `json:"seq"`
	Code           string          `json:"code"`
	Status         string          `json:"status"`
	MovementID     *string         `json:"movementId"`
	ExpectationID  *string         `json:"expectationId"`
	Account        *string         `json:"account"`
	Amount         *string         `json:"amount"`
	Asset          *Asset          `json:"asset"`
	Detail         string          `json:"detail"`
	Evidence       json.RawMessage `json:"evidence"`
	OpenedAt       string          `json:"openedAt"`
	ResolvedAt     *string         `json:"resolvedAt"`
	ResolutionNote *string         `json:"resolutionNote"`
}

type JournalLine struct {
	Account       string  `json:"account"`
	EntityID      *string `json:"entityId"`
	Role          string  `json:"role"`
	Side          string  `json:"side"`
	Amount        string  `json:"amount"`
	Asset         Asset   `json:"asset"`
	ExpectationID *string `json:"expectationId"`
	ExceptionID   *string `json:"exceptionId"`
}

type JournalEntry struct {
	ID          string        `json:"id"`
	Seq         int64         `json:"seq"`
	MovementID  *string       `json:"movementId"`
	PostingNo   *int64        `json:"postingNo"`
	Kind        string        `json:"kind"`
	EffectiveAt string        `json:"effectiveAt"`
	PostedAt    string        `json:"postedAt"`
	Description string        `json:"description"`
	Lines       []JournalLine `json:"lines"`
}

type MovementDetail struct {
	Movement    Movement          `json:"movement"`
	Allocations []Allocation      `json:"allocations"`
	Exceptions  []Exception       `json:"exceptions"`
	Journal     []JournalEntry    `json:"journal"`
	Refunds     []json.RawMessage `json:"refunds"`
	Decision    json.RawMessage   `json:"decision"`
}

type ExpectationDetail struct {
	Expectation Expectation  `json:"expectation"`
	Allocations []Allocation `json:"allocations"`
}

type ExceptionDetail struct {
	Exception   Exception    `json:"exception"`
	Movement    *Movement    `json:"movement"`
	Expectation *Expectation `json:"expectation"`
}

type Event struct {
	ID        string          `json:"id"`
	Seq       int64           `json:"seq"`
	Type      string          `json:"type"`
	SubjectID string          `json:"subjectId"`
	CreatedAt string          `json:"createdAt"`
	Data      json.RawMessage `json:"data"`
}

type WebhookConsumer struct {
	TenantID    string           `json:"tenantId"`
	Consumer    string           `json:"consumer"`
	Position    int64            `json:"position"`
	LatestSeq   int64            `json:"latestSeq"`
	Lag         int64            `json:"lag"`
	LastAttempt *DeliveryAttempt `json:"lastAttempt"`
	LastSuccess *DeliveryAttempt `json:"lastSuccess"`
	LastFailure *DeliveryAttempt `json:"lastFailure"`
}

type WebhookConsumerList struct {
	Data []WebhookConsumer `json:"data"`
}

type DeliveryAttempt struct {
	ID         string  `json:"id"`
	Seq        int64   `json:"seq"`
	EventID    string  `json:"eventId"`
	EventSeq   int64   `json:"eventSeq"`
	At         string  `json:"at"`
	HTTPStatus *int    `json:"httpStatus"`
	Error      *string `json:"error"`
	DurationMs int64   `json:"durationMs"`
	Outcome    string  `json:"outcome"`
	Reason     *string `json:"reason"`
}

type RewindRequest struct {
	ExpectedSeq int64  `json:"expectedSeq"`
	ToSeq       int64  `json:"toSeq"`
	Actor       string `json:"actor"`
}

type Rewind struct {
	ID       string `json:"id"`
	TenantID string `json:"tenantId"`
	Consumer string `json:"consumer"`
	FromSeq  int64  `json:"fromSeq"`
	ToSeq    int64  `json:"toSeq"`
	Actor    string `json:"actor"`
	At       string `json:"at"`
}
