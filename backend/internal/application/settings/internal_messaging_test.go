package settings

import (
	"context"
	"strconv"
	"testing"

	domainsettings "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/settings"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/config"
)

func TestInternalMessagingSeedPreservesConfiguredAndStoredEnabled(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(enabled), func(t *testing.T) {
			ctx := context.Background()
			repo := newSettingsSeedRepo()
			service := NewService(repo, "")
			if err := service.Seed(ctx, config.Config{InternalMessagingEnabled: enabled}); err != nil {
				t.Fatal(err)
			}
			if got := repo.items["internal_messaging:enabled"].Value; got != strconv.FormatBool(enabled) {
				t.Fatalf("seeded enabled = %q, want %v", got, enabled)
			}
			if err := service.Seed(ctx, config.Config{InternalMessagingEnabled: !enabled}); err != nil {
				t.Fatal(err)
			}
			if got := repo.items["internal_messaging:enabled"].Value; got != strconv.FormatBool(enabled) {
				t.Fatalf("restart overwrote stored enabled: %q", got)
			}
		})
	}
}

func TestInternalMessagingSettingsUpdateAndApply(t *testing.T) {
	ctx := context.Background()
	repo := newSettingsSeedRepo()
	service := NewService(repo, "")
	if err := service.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	patches := []PatchItem{
		{Namespace: "internal_messaging", Key: "enabled", Value: "true"},
		{Namespace: "internal_messaging", Key: "max_file_bytes", Value: "104857600"},
		{Namespace: "internal_messaging", Key: "retention_days", Value: "3650"},
		{Namespace: "internal_messaging", Key: "user_quota_bytes", Value: "1125899906842624"},
		{Namespace: "internal_messaging", Key: "browser_notifications", Value: "false"},
	}
	if _, err := service.BatchUpdate(ctx, patches); err != nil {
		t.Fatal(err)
	}
	runtime := config.NewRuntime(config.Config{InternalMessagingWebNotify: true})
	if err := NewRuntimeSettings(repo, nil, "").ApplyTo(ctx, runtime); err != nil {
		t.Fatal(err)
	}
	got := runtime.Snapshot()
	if !got.InternalMessagingEnabled || got.InternalMessagingMaxBytes != 100<<20 || got.InternalMessagingKeepDays != 3650 || got.InternalMessagingUserQuota != 1<<50 || got.InternalMessagingWebNotify {
		t.Fatal("stored internal messaging policy was not applied to runtime")
	}
	for _, test := range []struct{ key, value string }{
		{"enabled", "yes"}, {"browser_notifications", "yes"},
		{"max_file_bytes", "1048575"}, {"max_file_bytes", "104857601"},
		{"retention_days", "-1"}, {"retention_days", "3651"},
		{"user_quota_bytes", "-1"}, {"user_quota_bytes", "1125899906842625"},
	} {
		t.Run(test.key+"/"+test.value, func(t *testing.T) {
			before := repo.items["internal_messaging:"+test.key]
			_, err := service.BatchUpdate(ctx, []PatchItem{{Namespace: "internal_messaging", Key: test.key, Value: test.value}})
			if err == nil {
				t.Fatal("invalid policy accepted")
			}
			if after := repo.items["internal_messaging:"+test.key]; after != before {
				t.Fatal("invalid policy changed stored settings")
			}
		})
	}
}

func TestInternalMessagingSeedKeepsExistingPolicy(t *testing.T) {
	item := domainsettings.SystemSetting{Namespace: "internal_messaging", Key: "max_file_bytes", Value: "5242880", ValueType: "int"}
	repo := newSettingsSeedRepo(item)
	if err := NewService(repo, "").Seed(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := repo.items["internal_messaging:max_file_bytes"].Value; got != item.Value {
		t.Fatalf("existing file limit changed to %q", got)
	}
}
