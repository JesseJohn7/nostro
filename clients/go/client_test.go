package nostro

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestVerifyWebhookValid(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"id":"evt_1","type":"movement.recorded"}`)
	now := time.Unix(1710000000, 0)
	header := SignWebhook(secret, body, now)
	if !VerifyWebhook(secret, header, body, 5*time.Minute, now.Add(10*time.Second)) {
		t.Fatal("expected valid signature")
	}
}

func TestVerifyWebhookExpired(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"id":"evt_1"}`)
	now := time.Unix(1710000000, 0)
	header := SignWebhook(secret, body, now)
	if VerifyWebhook(secret, header, body, 5*time.Minute, now.Add(6*time.Minute)) {
		t.Fatal("expected expired signature to be rejected")
	}
}

func TestVerifyWebhookTampered(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"id":"evt_1"}`)
	now := time.Unix(1710000000, 0)
	header := SignWebhook(secret, body, now)
	tampered := []byte(`{"id":"evt_2"}`)
	if VerifyWebhook(secret, header, tampered, 5*time.Minute, now) {
		t.Fatal("expected tampered body to be rejected")
	}
}

func TestVerifyWebhookMalformed(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"id":"evt_1"}`)
	now := time.Unix(1710000000, 0)
	for _, header := range []string{
		"",
		"t=abc,v1=def",
		"t=1710000000",
		"v1=deadbeef",
		"t=1710000000,v1=zz",
		"t=1710000000,v1=" + stringsRepeat("a", 63),
	} {
		if VerifyWebhook(secret, header, body, 5*time.Minute, now) {
			t.Fatalf("expected malformed header to be rejected: %q", header)
		}
	}
}

func stringsRepeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func TestAmountRoundTripLargeExact(t *testing.T) {
	// 10^30 + 0.0000001 represented exactly as decimal string.
	const raw = "1000000000000000000000000000000"
	const decimals = 7
	amount := MustAmount(raw, decimals)
	got := amount.String()
	want := "100000000000000000000000.0000000"
	if got != want {
		t.Fatalf("string: got %s want %s", got, want)
	}
	parsed, err := ParseAmount(got, decimals)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !parsed.Equal(amount) {
		t.Fatalf("round trip mismatch: got %s want %s", parsed.Raw().String(), amount.Raw().String())
	}
	b, err := json.Marshal(parsed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(b) != `"`+want+`"` {
		t.Fatalf("json: got %s", string(b))
	}
}

func TestClientPaging(t *testing.T) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.String())
		if got := r.Header.Get("Authorization"); got != "Bearer key" {
			t.Fatalf("auth header: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("after") == "" {
			_, _ = w.Write([]byte(`{"data":[{"id":"e1","seq":1,"type":"movement.recorded","subjectId":"m1","createdAt":"2026-01-01T00:00:00Z","data":{}}],"next":1}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"e2","seq":2,"type":"movement.recorded","subjectId":"m2","createdAt":"2026-01-01T00:00:01Z","data":{}}],"next":null}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key")
	first, err := c.ListEvents(context.Background(), nil)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	items, err := CollectPages(context.Background(), first, func(ctx context.Context, after *int64) (Page[Event], error) {
		return c.ListEvents(ctx, &ListOptions{After: after})
	})
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(items) != 2 || items[0].ID != "e1" || items[1].ID != "e2" {
		t.Fatalf("unexpected items: %+v", items)
	}
	if len(calls) != 2 || calls[1] != "/v1/events?after=1" {
		t.Fatalf("unexpected calls: %#v", calls)
	}
}

func TestClientProblemCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"type":"about:blank","title":"Not Found","status":404,"code":"not_found","detail":"No movement m1."}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key")
	_, err := c.GetMovement(context.Background(), "m1")
	if err == nil {
		t.Fatal("expected error")
	}
	var p *Problem
	if !errors.As(err, &p) {
		t.Fatalf("expected Problem, got %T: %v", err, err)
	}
	if p.Code != "not_found" || p.Status != 404 {
		t.Fatalf("unexpected problem: %+v", p)
	}
}
