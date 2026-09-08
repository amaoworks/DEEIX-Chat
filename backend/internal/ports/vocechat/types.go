// Package vocechat defines the data contract for the internal messaging integration.
package vocechat

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type User struct {
	UID int64 `json:"uid"`
}

type Login struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type Message struct {
	MID     int64 `json:"mid"`
	FromUID int64 `json:"from_uid"`
	Target  struct {
		UID int64 `json:"uid"`
	} `json:"target"`
	// CreatedAt is an RFC3339 string in older VoceChat releases and a Unix
	// millisecond timestamp in current releases. Keep the wire value raw and
	// normalize it for the DEEIX API at the boundary.
	CreatedAt json.RawMessage `json:"created_at"`
	Detail    struct {
		Type        string                     `json:"type"`
		ContentType string                     `json:"content_type"`
		Content     string                     `json:"content"`
		MID         int64                      `json:"mid"`
		Properties  map[string]json.RawMessage `json:"properties"`
		Reaction    struct {
			Type        string                     `json:"type"`
			ContentType string                     `json:"content_type"`
			Content     string                     `json:"content"`
			Properties  map[string]json.RawMessage `json:"properties"`
		} `json:"detail"`
	} `json:"detail"`
}

type UploadedFile struct {
	Path            string `json:"path"`
	Size            int64  `json:"size"`
	Hash            string `json:"hash"`
	ImageProperties *struct {
		Width  uint32 `json:"width"`
		Height uint32 `json:"height"`
	} `json:"image_properties"`
}

// CreatedAtRFC3339 returns a browser-friendly timestamp across supported
// VoceChat releases. An unknown value is intentionally represented by an
// empty string rather than making an otherwise valid history response fail.
func (m Message) CreatedAtRFC3339() string {
	if len(m.CreatedAt) == 0 || string(m.CreatedAt) == "null" {
		return ""
	}

	var text string
	if err := json.Unmarshal(m.CreatedAt, &text); err == nil {
		if _, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return text
		}
		if timestamp, err := parseUnixTimestamp(text); err == nil {
			return timestamp.UTC().Format(time.RFC3339Nano)
		}
		return text
	}

	if timestamp, err := parseUnixTimestamp(string(m.CreatedAt)); err == nil {
		return timestamp.UTC().Format(time.RFC3339Nano)
	}
	return ""
}

func parseUnixTimestamp(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	integer, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return time.Time{}, err
	}
	// Current VoceChat uses milliseconds; accepting seconds preserves
	// compatibility with releases that use the conventional Unix unit.
	if integer > 100_000_000_000 || integer < -100_000_000_000 {
		return time.UnixMilli(integer), nil
	}
	return time.Unix(integer, 0), nil
}
