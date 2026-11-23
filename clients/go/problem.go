package nostro

import (
	"encoding/json"
	"fmt"
)

// Problem represents an RFC 9457 problem detail returned by the Nostro API.
type Problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

func (p *Problem) Error() string {
	if p == nil {
		return "<nil>"
	}
	if p.Code != "" {
		return fmt.Sprintf("nostro: %s (%d %s): %s", p.Code, p.Status, p.Title, p.Detail)
	}
	return fmt.Sprintf("nostro: %d %s: %s", p.Status, p.Title, p.Detail)
}

// Is allows errors.Is checks against a Problem code.
func (p *Problem) Is(target error) bool {
	t, ok := target.(*Problem)
	if !ok || p == nil {
		return false
	}
	if t.Code != "" {
		return p.Code == t.Code
	}
	return p.Status == t.Status
}

func decodeProblem(status int, body []byte) error {
	var p Problem
	if err := json.Unmarshal(body, &p); err == nil && (p.Code != "" || p.Title != "" || p.Status != 0) {
		if p.Status == 0 {
			p.Status = status
		}
		return &p
	}
	detail := string(body)
	if detail == "" {
		detail = fmt.Sprintf("request failed with status %d", status)
	}
	return &Problem{Type: "about:blank", Title: httpStatusTitle(status), Status: status, Detail: detail}
}

func httpStatusTitle(status int) string {
	switch status {
	case 400:
		return "Bad Request"
	case 401:
		return "Unauthorized"
	case 403:
		return "Forbidden"
	case 404:
		return "Not Found"
	case 409:
		return "Conflict"
	case 410:
		return "Gone"
	case 422:
		return "Unprocessable Content"
	case 429:
		return "Too Many Requests"
	case 500:
		return "Internal Server Error"
	case 501:
		return "Not Implemented"
	default:
		return "Error"
	}
}
