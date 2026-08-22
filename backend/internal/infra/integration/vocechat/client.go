// Package vocechat is a deliberately small client for the subset of VoceChat
// used by DEEIX's internal direct-message feature.
package vocechat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	baseURL string
	secret  string
	http    *http.Client
	events  *http.Client
}

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

func New(baseURL, secret string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		secret:  secret,
		http:    &http.Client{Timeout: timeout},
		// An SSE stream is intentionally long lived; request cancellation is
		// supplied by the caller instead of a fixed HTTP timeout.
		events: &http.Client{},
	}
}

// LoginAs mints a short-lived third-party key inside the private network and
// exchanges it immediately. Neither key nor VoceChat token reaches the browser.
func (c *Client) LoginAs(ctx context.Context, publicID, name string) (Login, error) {
	var key string
	if err := c.requestJSON(ctx, http.MethodPost, "/api/token/create_third_party_key", "", map[string]string{"userid": publicID, "username": name}, &key, http.Header{"X-SECRET": []string{c.secret}}); err != nil {
		return Login{}, err
	}
	var login Login
	payload := map[string]interface{}{"credential": map[string]string{"type": "thirdparty", "key": key}, "device": "deeix-internal-messaging"}
	if err := c.requestJSON(ctx, http.MethodPost, "/api/token/login", "", payload, &login, nil); err != nil {
		return Login{}, err
	}
	if login.Token == "" || login.User.UID == 0 {
		return Login{}, fmt.Errorf("vocechat login returned no user token")
	}
	return login, nil
}

func (c *Client) Healthy(ctx context.Context) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func (c *Client) History(ctx context.Context, token string, uid int64, before int64, limit int) ([]Message, error) {
	path := fmt.Sprintf("/api/user/%d/history?limit=%d", uid, limit)
	if before > 0 {
		path += fmt.Sprintf("&before=%d", before)
	}
	var messages []Message
	if err := c.requestJSON(ctx, http.MethodGet, path, token, nil, &messages, nil); err != nil {
		return nil, err
	}
	return messages, nil
}

func (c *Client) Send(ctx context.Context, token string, uid int64, content string) (int64, error) {
	var mid int64
	if err := c.requestRaw(ctx, http.MethodPost, fmt.Sprintf("/api/user/%d/send", uid), token, "text/plain", []byte(content), &mid, nil); err != nil {
		return 0, err
	}
	return mid, nil
}

func (c *Client) Reply(ctx context.Context, token string, mid int64, content string) (int64, error) {
	var createdMID int64
	if err := c.requestRaw(ctx, http.MethodPost, fmt.Sprintf("/api/message/%d/reply", mid), token, "text/plain", []byte(content), &createdMID, nil); err != nil {
		return 0, err
	}
	return createdMID, nil
}

func (c *Client) Edit(ctx context.Context, token string, mid int64, content string) (int64, error) {
	var reactionMID int64
	if err := c.requestRaw(ctx, http.MethodPut, fmt.Sprintf("/api/message/%d/edit", mid), token, "text/plain", []byte(content), &reactionMID, nil); err != nil {
		return 0, err
	}
	return reactionMID, nil
}

func (c *Client) Delete(ctx context.Context, token string, mid int64) (int64, error) {
	var reactionMID int64
	if err := c.requestJSON(ctx, http.MethodDelete, fmt.Sprintf("/api/message/%d", mid), token, nil, &reactionMID, nil); err != nil {
		return 0, err
	}
	return reactionMID, nil
}

func (c *Client) UploadFile(ctx context.Context, token, filename, contentType string, content []byte) (UploadedFile, error) {
	var fileID string
	if err := c.requestJSON(ctx, http.MethodPost, "/api/resource/file/prepare", token, map[string]interface{}{
		"filename": filename, "content_type": contentType,
	}, &fileID, nil); err != nil {
		return UploadedFile{}, err
	}
	if fileID == "" {
		return UploadedFile{}, fmt.Errorf("vocechat file prepare returned no file id")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("file_id", fileID); err != nil {
		return UploadedFile{}, err
	}
	part, err := writer.CreateFormFile("chunk_data", filename)
	if err != nil {
		return UploadedFile{}, err
	}
	if _, err = part.Write(content); err != nil {
		return UploadedFile{}, err
	}
	if err = writer.WriteField("chunk_is_last", "true"); err != nil {
		return UploadedFile{}, err
	}
	if err = writer.Close(); err != nil {
		return UploadedFile{}, err
	}
	var uploaded *UploadedFile
	if err = c.requestRaw(ctx, http.MethodPost, "/api/resource/file/upload", token, writer.FormDataContentType(), body.Bytes(), &uploaded, nil); err != nil {
		return UploadedFile{}, err
	}
	if uploaded == nil || uploaded.Path == "" {
		return UploadedFile{}, fmt.Errorf("vocechat file upload returned no path")
	}
	return *uploaded, nil
}

func (c *Client) SendFile(ctx context.Context, token string, uid int64, path string) (int64, error) {
	payload, err := json.Marshal(map[string]string{"path": path})
	if err != nil {
		return 0, err
	}
	var mid int64
	if err = c.requestRaw(ctx, http.MethodPost, fmt.Sprintf("/api/user/%d/send", uid), token, "vocechat/file", payload, &mid, nil); err != nil {
		return 0, err
	}
	return mid, nil
}

func (c *Client) DownloadFile(ctx context.Context, token, path string, thumbnail bool) (*http.Response, error) {
	query := url.Values{"file_path": []string{path}}
	if thumbnail {
		query.Set("thumbnail", "true")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/resource/file?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", token)
	resp, err := c.events.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, responseError(resp)
	}
	return resp, nil
}

func (c *Client) UpdateName(ctx context.Context, token, name string) error {
	return c.requestJSON(ctx, http.MethodPut, "/api/user/", token, map[string]string{"name": name}, nil, nil)
}

func (c *Client) Events(ctx context.Context, token string, afterMID int64) (*http.Response, error) {
	query := url.Values{"api-key": []string{token}}
	if afterMID > 0 {
		query.Set("after_mid", fmt.Sprint(afterMID))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/user/events?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.events.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, responseError(resp)
	}
	return resp, nil
}

func (c *Client) requestJSON(ctx context.Context, method, path, token string, payload, output interface{}, headers http.Header) error {
	data, err := json.Marshal(payload)
	if payload == nil {
		data = nil
	} else if err != nil {
		return err
	}
	return c.requestRaw(ctx, method, path, token, "application/json; charset=utf-8", data, output, headers)
}

func (c *Client) requestRaw(ctx context.Context, method, path, token, contentType string, payload []byte, output interface{}, headers http.Header) error {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("X-API-Key", token)
	}
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return responseError(resp)
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(output)
}

func responseError(resp *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return fmt.Errorf("vocechat request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(data)))
}
