package vocechat

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type uploadTransport func(*http.Request) (*http.Response, error)

func (f uploadTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type generatedFile struct{}

func (generatedFile) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func streamingClient(check func(error), size int64) *Client {
	c := New("http://vocechat.test", "", time.Second)
	c.http.Transport = uploadTransport(func(r *http.Request) (*http.Response, error) {
		body := `"file-id"`
		if r.URL.Path == "/api/resource/file/upload" {
			reader, err := r.MultipartReader()
			if err != nil {
				return nil, err
			}
			fields := map[string]string{}
			var fileBytes int64
			for {
				part, partErr := reader.NextPart()
				if partErr == io.EOF {
					break
				}
				if partErr != nil {
					return nil, partErr
				}
				if part.FormName() == "chunk_data" {
					fileBytes, err = io.Copy(io.Discard, part)
					if err != nil {
						return nil, err
					}
				} else {
					value, readErr := io.ReadAll(part)
					if readErr != nil {
						return nil, readErr
					}
					fields[part.FormName()] = string(value)
				}
			}
			if fileBytes != size || fields["file_id"] != "file-id" || fields["chunk_is_last"] != "true" || r.ContentLength <= size {
				check(fmt.Errorf("invalid multipart: size=%d fields=%v contentLength=%d", fileBytes, fields, r.ContentLength))
			}
			body = fmt.Sprintf(`{"path":"file/path","size":%d}`, size)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	return c
}

func TestFileUploadStreamsMultipartWithExactSize(t *testing.T) {
	const size = int64(2 << 20)
	c := streamingClient(func(err error) { t.Error(err) }, size)
	file, err := c.UploadFileStream(context.Background(), "private-token", "sample.bin", "application/octet-stream", io.LimitReader(generatedFile{}, size), size)
	if err != nil || file.Size != size {
		t.Fatalf("file=%+v err=%v", file, err)
	}
}

func BenchmarkUploadFileStream(b *testing.B) {
	for _, size := range []int64{1 << 20, 20 << 20} {
		b.Run(fmt.Sprintf("%dMiB", size>>20), func(b *testing.B) {
			c := streamingClient(func(err error) { b.Fatal(err) }, size)
			b.ReportAllocs()
			b.SetBytes(size)
			b.ResetTimer()
			for b.Loop() {
				if _, err := c.UploadFileStream(context.Background(), "token", "file.bin", "application/octet-stream", io.LimitReader(generatedFile{}, size), size); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
