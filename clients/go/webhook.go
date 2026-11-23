package nostro

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	// SignatureHeader is the webhook signature header name.
	SignatureHeader = "nostro-signature"
	// DefaultWebhookTolerance is the default replay window.
	DefaultWebhookTolerance = 300 * time.Second
)

// SignWebhook returns the Nostro-Signature header value for raw body at timestamp t.
func SignWebhook(secret string, body []byte, t time.Time) string {
	ts := t.Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.%s", ts, body)
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

// VerifyWebhook verifies Nostro-Signature over the raw body.
// It compares in constant time and rejects stale/future timestamps.
func VerifyWebhook(secret string, header string, body []byte, tolerance time.Duration, now time.Time) bool {
	if tolerance <= 0 {
		tolerance = DefaultWebhookTolerance
	}
	parts := strings.Split(header, ",")
	values := make(map[string]string, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			return false
		}
		values[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
	}
	tsRaw, okT := values["t"]
	v1, okV1 := values["v1"]
	if !okT || !okV1 || len(tsRaw) == 0 || len(tsRaw) > 12 {
		return false
	}
	for i := 0; i < len(tsRaw); i++ {
		if tsRaw[i] < '0' || tsRaw[i] > '9' {
			return false
		}
	}
	if len(v1) != 64 {
		return false
	}
	for i := 0; i < len(v1); i++ {
		c := v1[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	sig, err := hex.DecodeString(v1)
	if err != nil {
		return false
	}
	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		return false
	}
	delta := now.Unix() - ts
	if delta < 0 {
		delta = -delta
	}
	if delta > int64(tolerance/time.Second) {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.%s", ts, body)
	expected := mac.Sum(nil)
	return hmac.Equal(sig, expected)
}
