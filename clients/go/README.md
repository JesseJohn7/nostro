# Nostro Go Client

Minimal stdlib-only Go client for the Nostro API.

## Install

```bash
go get github.com/nostro-labs/nostro/clients/go
```

## Client

```go
c := nostro.NewClient("https://nostro.example.com", os.Getenv("NOSTRO_API_KEY"))
page, err := c.ListEvents(ctx, nil)
```

The client uses `context.Context`, Bearer API key auth, JSON decoding, and returns
typed `*nostro.Problem` errors for RFC 9457 problem responses. `Problem` includes
`Status` and `Code`.

## Paging

List endpoints return `nostro.Page[T]{Data, Next}`. Follow `Next` until nil:

```go
page, err := c.ListEvents(ctx, nil)
if err != nil { return err }
for {
    for _, ev := range page.Data {
        handle(ev)
    }
    if !page.HasNext() {
        break
    }
    after := *page.Next
    page, err = c.ListEvents(ctx, &nostro.ListOptions{After: &after})
    if err != nil { return err }
}
```

`CollectPages` can also follow cursors for simple cases.

## Exact Amounts

`Amount` stores raw integer units (`*big.Int`) plus decimals. It parses/writes
decimal strings and never uses `float64`.

```go
a, err := nostro.ParseAmount("25.0000000", 7)
fmt.Println(a.String()) // 25.0000000
fmt.Println(a.Raw())    // 250000000
```

Assets are represented as full canonical strings: `native` or `CODE:ISSUER`.

## Webhook Verification

Webhooks use `nostro-signature: t=<unix>,v1=<hex>` where `v1` is HMAC-SHA256 of
`<t>.<raw-body>` using the shared secret. Verify the raw body before parsing JSON.
Verification is constant-time and rejects malformed/stale/tampered signatures
(default tolerance 300s).

```go
func webhookHandler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read body", http.StatusBadRequest)
			return
		}
		header := r.Header.Get(nostro.SignatureHeader)
		if !nostro.VerifyWebhook(secret, header, body, nostro.DefaultWebhookTolerance, time.Now()) {
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}

		var event nostro.Event
		if err := json.Unmarshal(body, &event); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}

		// Deduplicate by event.ID; delivery is at-least-once.
		fmt.Println("event", event.Type, event.ID)
		w.WriteHeader(http.StatusNoContent)
	}
}
```

`SignWebhook` is provided for tests/tools; it does not handle secrets storage.

## Scope

This module is intentionally thin and stdlib-only. It covers main list/get/event/journal/webhook
endpoints and webhook verification. It does not perform transaction signing.
