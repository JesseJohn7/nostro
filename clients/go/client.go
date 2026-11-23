package nostro

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Client is a thin Nostro API client. It uses Bearer API key auth and decodes
// RFC 9457 problem details into *Problem errors.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// NewClient creates a client. baseURL should point at the Nostro server root,
// e.g. https://nostro.example.com.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		APIKey:     apiKey,
		HTTPClient: http.DefaultClient,
	}
}

type ListOptions struct {
	After  *int64
	Limit  *int
	Query  map[string]string
}

func (o *ListOptions) query() url.Values {
	v := url.Values{}
	if o == nil {
		return v
	}
	if o.After != nil {
		v.Set("after", strconv.FormatInt(*o.After, 10))
	}
	if o.Limit != nil {
		v.Set("limit", strconv.Itoa(*o.Limit))
	}
	for k, val := range o.Query {
		if val != "" {
			v.Set(k, val)
		}
	}
	return v
}

func (c *Client) doJSON(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	if c.HTTPClient == nil {
		c.HTTPClient = http.DefaultClient
	}
	u := c.BaseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, r)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	req.Header.Set("Accept", "application/json, application/problem+json")
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return decodeProblem(resp.StatusCode, data)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func listPath(path string, opts *ListOptions) (string, url.Values) {
	return path, opts.query()
}

func (c *Client) ListMovements(ctx context.Context, opts *ListOptions) (Page[Movement], error) {
	path, q := listPath("/v1/movements", opts)
	var page Page[Movement]
	err := c.doJSON(ctx, http.MethodGet, path, q, nil, &page)
	return page, err
}

func (c *Client) GetMovement(ctx context.Context, id string) (*MovementDetail, error) {
	var out MovementDetail
	if err := c.doJSON(ctx, http.MethodGet, "/v1/movements/"+url.PathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ListExpectations(ctx context.Context, opts *ListOptions) (Page[Expectation], error) {
	path, q := listPath("/v1/expectations", opts)
	var page Page[Expectation]
	err := c.doJSON(ctx, http.MethodGet, path, q, nil, &page)
	return page, err
}

func (c *Client) GetExpectation(ctx context.Context, id string) (*ExpectationDetail, error) {
	var out ExpectationDetail
	if err := c.doJSON(ctx, http.MethodGet, "/v1/expectations/"+url.PathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetExpectationByReference(ctx context.Context, reference string) (*ExpectationDetail, error) {
	q := url.Values{}
	q.Set("reference", reference)
	var out ExpectationDetail
	if err := c.doJSON(ctx, http.MethodGet, "/v1/expectations/by-reference", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ListExceptions(ctx context.Context, opts *ListOptions) (Page[Exception], error) {
	path, q := listPath("/v1/exceptions", opts)
	var page Page[Exception]
	err := c.doJSON(ctx, http.MethodGet, path, q, nil, &page)
	return page, err
}

func (c *Client) GetException(ctx context.Context, id string) (*ExceptionDetail, error) {
	var out ExceptionDetail
	if err := c.doJSON(ctx, http.MethodGet, "/v1/exceptions/"+url.PathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ListEvents(ctx context.Context, opts *ListOptions) (Page[Event], error) {
	path, q := listPath("/v1/events", opts)
	var page Page[Event]
	err := c.doJSON(ctx, http.MethodGet, path, q, nil, &page)
	return page, err
}

func (c *Client) ListJournalEntries(ctx context.Context, opts *ListOptions) (Page[JournalEntry], error) {
	path, q := listPath("/v1/journal", opts)
	var page Page[JournalEntry]
	err := c.doJSON(ctx, http.MethodGet, path, q, nil, &page)
	return page, err
}

func (c *Client) ListWebhooks(ctx context.Context) (*WebhookConsumerList, error) {
	var out WebhookConsumerList
	if err := c.doJSON(ctx, http.MethodGet, "/v1/webhooks", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetWebhookStatus(ctx context.Context, consumer string) (*WebhookConsumer, error) {
	var out WebhookConsumer
	if err := c.doJSON(ctx, http.MethodGet, "/v1/webhooks/"+url.PathEscape(consumer)+"/status", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ListWebhookAttempts(ctx context.Context, consumer string, opts *ListOptions) (Page[DeliveryAttempt], error) {
	path, q := listPath("/v1/webhooks/"+url.PathEscape(consumer)+"/attempts", opts)
	var page Page[DeliveryAttempt]
	err := c.doJSON(ctx, http.MethodGet, path, q, nil, &page)
	return page, err
}

func (c *Client) ReplayWebhook(ctx context.Context, consumer string, req RewindRequest) (*Rewind, error) {
	var out Rewind
	if err := c.doJSON(ctx, http.MethodPost, "/v1/webhooks/"+url.PathEscape(consumer)+"/replay", nil, req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
