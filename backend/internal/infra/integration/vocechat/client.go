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
	"strings"
	"time"

	voceport "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/vocechat"
)

type Client struct {
	baseURL string
	secret  string
	http    *http.Client
	events  *http.Client
}

type User = voceport.User
type Login = voceport.Login
type Message = voceport.Message
type UploadedFile = voceport.UploadedFile

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
	payload := map[string]any{"credential": map[string]string{"type": "thirdparty", "key": key}, "device": "deeix-internal-messaging"}
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
	return c.UploadFileStream(ctx, token, filename, contentType, bytes.NewReader(content), int64(len(content)))
}

func (c *Client) UploadFileStream(ctx context.Context, token, filename, contentType string, content io.Reader, size int64) (UploadedFile, error) {
	var fileID string
	if err := c.requestJSON(ctx, http.MethodPost, "/api/resource/file/prepare", token, map[string]any{
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
	_, err := writer.CreateFormFile("chunk_data", filename)
	if err != nil {
		return UploadedFile{}, err
	}
	prefix := append([]byte(nil), body.Bytes()...)
	body.Reset()
	if err = writer.WriteField("chunk_is_last", "true"); err != nil {
		return UploadedFile{}, err
	}
	if err = writer.Close(); err != nil {
		return UploadedFile{}, err
	}
	var uploaded *UploadedFile
	if err = c.requestReader(ctx, http.MethodPost, "/api/resource/file/upload", token, writer.FormDataContentType(), io.MultiReader(bytes.NewReader(prefix), content, bytes.NewReader(body.Bytes())), int64(len(prefix))+size+int64(body.Len()), &uploaded, nil); err != nil {
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

func (c *Client) requestJSON(ctx context.Context, method, path, token string, payload, output any, headers http.Header) error {
	data, err := json.Marshal(payload)
	if payload == nil {
		data = nil
	} else if err != nil {
		return err
	}
	return c.requestRaw(ctx, method, path, token, "application/json; charset=utf-8", data, output, headers)
}

func (c *Client) requestRaw(ctx context.Context, method, path, token, contentType string, payload []byte, output any, headers http.Header) error {
	return c.requestReader(ctx, method, path, token, contentType, bytes.NewReader(payload), int64(len(payload)), output, headers)
}

func (c *Client) requestReader(ctx context.Context, method, path, token, contentType string, payload io.Reader, size int64, output any, headers http.Header) error {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, payload)
	if err != nil {
		return err
	}
	req.ContentLength = size
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
