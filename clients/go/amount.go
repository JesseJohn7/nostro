package nostro

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

// Amount is an exact decimal amount represented in raw units and decimals.
// It never uses float64.
type Amount struct {
	raw      *big.Int
	decimals int
}

// NewAmount creates an Amount from raw units and decimal places.
func NewAmount(raw *big.Int, decimals int) (Amount, error) {
	if raw == nil {
		return Amount{}, fmt.Errorf("amount raw is nil")
	}
	if decimals < 0 || decimals > 38 {
		return Amount{}, fmt.Errorf("invalid decimals %d: expected 0..38", decimals)
	}
	return Amount{raw: new(big.Int).Set(raw), decimals: decimals}, nil
}

// MustAmount panics on invalid input. Useful for static test vectors.
func MustAmount(raw string, decimals int) Amount {
	n, ok := new(big.Int).SetString(raw, 10)
	if !ok {
		panic(fmt.Sprintf("invalid raw amount %q", raw))
	}
	a, err := NewAmount(n, decimals)
	if err != nil {
		panic(err)
	}
	return a
}

// ParseAmount parses a decimal string like "12.5000000" into raw units.
// It rejects fractional precision beyond decimals.
func ParseAmount(value string, decimals int) (Amount, error) {
	if decimals < 0 || decimals > 38 {
		return Amount{}, fmt.Errorf("invalid decimals %d: expected 0..38", decimals)
	}
	s := strings.TrimSpace(value)
	if s == "" {
		return Amount{}, fmt.Errorf("invalid amount %q", value)
	}
	neg := false
	if strings.HasPrefix(s, "+") {
		s = s[1:]
	} else if strings.HasPrefix(s, "-") {
		neg = true
		s = s[1:]
	}
	if s == "" {
		return Amount{}, fmt.Errorf("invalid amount %q", value)
	}
	parts := strings.Split(s, ".")
	if len(parts) > 2 {
		return Amount{}, fmt.Errorf("invalid amount %q", value)
	}
	whole := parts[0]
	frac := ""
	if len(parts) == 2 {
		frac = parts[1]
	}
	if whole == "" {
		whole = "0"
	}
	if !isDigits(whole) || !isDigits(frac) {
		return Amount{}, fmt.Errorf("invalid amount %q", value)
	}
	if len(frac) > decimals {
		return Amount{}, fmt.Errorf("amount %q has %d decimal places but asset supports %d; refusing to round", value, len(frac), decimals)
	}
	scaled := whole + padRight(frac, decimals)
	raw, ok := new(big.Int).SetString(scaled, 10)
	if !ok {
		return Amount{}, fmt.Errorf("invalid amount %q", value)
	}
	if neg {
		raw.Neg(raw)
	}
	return Amount{raw: raw, decimals: decimals}, nil
}

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func padRight(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat("0", n-len(s))
}

// Raw returns a copy of raw units.
func (a Amount) Raw() *big.Int {
	if a.raw == nil {
		return new(big.Int)
	}
	return new(big.Int).Set(a.raw)
}

// Decimals returns decimal places.
func (a Amount) Decimals() int { return a.decimals }

// IsZero reports whether the amount is zero.
func (a Amount) IsZero() bool { return a.raw != nil && a.raw.Sign() == 0 }

// String renders an exact decimal string with exactly decimals places.
func (a Amount) String() string {
	if a.raw == nil {
		raw := new(big.Int)
		return formatRaw(raw, a.decimals)
	}
	return formatRaw(a.raw, a.decimals)
}

func formatRaw(raw *big.Int, decimals int) string {
	neg := raw.Sign() < 0
	abs := new(big.Int).Abs(raw)
	digits := abs.String()
	if decimals == 0 {
		if neg {
			return "-" + digits
		}
		return digits
	}
	if len(digits) <= decimals {
		digits = strings.Repeat("0", decimals-len(digits)+1) + digits
	}
	split := len(digits) - decimals
	out := digits[:split] + "." + digits[split:]
	if neg {
		return "-" + out
	}
	return out
}

// MarshalJSON encodes the amount as a decimal string.
func (a Amount) MarshalJSON() ([]byte, error) {
	return json.Marshal(a.String())
}

// UnmarshalJSON decodes a decimal string. If decimals are preconfigured on the
// receiver, that precision is enforced; otherwise scale is inferred from the string.
func (a *Amount) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("amount must be a JSON string: %w", err)
	}
	decimals := a.decimals
	if decimals == 0 && strings.Contains(strings.TrimSpace(s), ".") {
		parts := strings.SplitN(strings.TrimSpace(s), ".", 2)
		if len(parts) == 2 {
			decimals = len(parts[1])
		}
	}
	parsed, err := ParseAmount(s, decimals)
	if err != nil {
		return err
	}
	*a = parsed
	return nil
}

// Equal reports exact equality of raw units and decimals.
func (a Amount) Equal(other Amount) bool {
	if a.decimals != other.decimals {
		return false
	}
	if a.raw == nil || other.raw == nil {
		return a.raw == other.raw
	}
	return a.raw.Cmp(other.raw) == 0
}
