// Package client mimics the shapes openapi-generator emits for Go.
package client

import (
	"encoding/json"
	"fmt"
)

// ResultStatus the model 'ResultStatus'
type ResultStatus string

const (
	RESULTSTATUS_COMMITTED ResultStatus = "COMMITTED"
	RESULTSTATUS_ERROR     ResultStatus = "ERROR"
)

var allowedResultStatus = []ResultStatus{"COMMITTED", "ERROR"}

func (v *ResultStatus) UnmarshalJSON(src []byte) error {
	var value string
	if err := json.Unmarshal(src, &value); err != nil {
		return err
	}
	for _, existing := range allowedResultStatus {
		if string(existing) == value {
			*v = existing
			return nil
		}
	}
	return fmt.Errorf("invalid value %q for ResultStatus", value)
}

// LooseStatus has constants but no strict decode, so it is not an enum.
type LooseStatus string

const LOOSE_A LooseStatus = "A"

type BatchResult struct {
	Error *BatchError `json:"error,omitempty"`
	// EventID is the event's UUID (empty for events that failed JSON parsing).
	EventId string `json:"event_id"`
	// Index is the zero-based position of this event in the request array.
	Index  int32        `json:"index"`
	Status ResultStatus `json:"status"`
	Items  []string     `json:"items"`
	Loose  LooseStatus  `json:"loose"`
}

type BatchError struct {
	// HTTP status the single-event endpoint would return for this failure.
	Status int32  `json:"status"`
	Type   string `json:"type"`
}

type Movement struct {
	// Amount in minor units (must be > 0).
	Amount int64 `json:"amount"`
	SiteId int32 `json:"site_id"`
	// Counts are non-negative.
	Count int64 `json:"count"`
}

func (o *BatchResult) GetIndex() int32 { return o.Index }
