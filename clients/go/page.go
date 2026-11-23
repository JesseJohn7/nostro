package nostro

import "context"

// Page is a paginated response. Next is the cursor to pass as `after`; nil on last page.
type Page[T any] struct {
	Data []T   `json:"data"`
	Next *int64 `json:"next"`
}

// HasNext reports whether another page exists.
func (p Page[T]) HasNext() bool { return p.Next != nil }

// ListFunc fetches one page given an after cursor.
type ListFunc[T any] func(ctx context.Context, after *int64) (Page[T], error)

// CollectPages follows next cursors and returns all items.
func CollectPages[T any](ctx context.Context, first Page[T], nextFn ListFunc[T]) ([]T, error) {
	items := make([]T, 0, len(first.Data))
	items = append(items, first.Data...)
	page := first
	for page.HasNext() {
		after := *page.Next
		var err error
		page, err = nextFn(ctx, &after)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Data...)
	}
	return items, nil
}
