"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import {
  getAdminInternalMessagingStatus,
  listAdminSettingsByNamespace,
  patchAdminSettings,
  type AdminInternalMessagingStatus,
} from "@/features/admin/api/settings";
import { useAuthSession } from "@/shared/auth/auth-session-context";

const NAMESPACE = "internal_messaging";
type FormState = {
  enabled: boolean;
  browserNotifications: boolean;
  maxFileMB: string;
  quotaMB: string;
  retentionDays: string;
};

const EMPTY_FORM: FormState = {
  enabled: false,
  browserNotifications: true,
  maxFileMB: "20",
  quotaMB: "0",
  retentionDays: "0",
};


export function useAdminInternalMessaging() {
  const t = useTranslations("adminUsers.internalMessagingPage");
  const { accessToken } = useAuthSession();
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [status, setStatus] = React.useState<AdminInternalMessagingStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setNotice("");
    try {
      const [items, runtime] = await Promise.all([
        listAdminSettingsByNamespace(accessToken, NAMESPACE),
        getAdminInternalMessagingStatus(accessToken),
      ]);
      const values = Object.fromEntries(items.map((item) => [item.key, item.value]));
      setForm({
        enabled: values.enabled === "true",
        browserNotifications: values.browser_notifications !== "false",
        maxFileMB: bytesToMB(values.max_file_bytes, "20"),
        quotaMB: bytesToMB(values.user_quota_bytes, "0"),
        retentionDays: values.retention_days || "0",
      });
      setStatus(runtime);
    } catch {
      setNotice(t("failed"));
    } finally {
      setLoading(false);
    }
  }, [accessToken, t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setNotice("");
    try {
      await patchAdminSettings(accessToken, {
        items: [
          { namespace: NAMESPACE, key: "enabled", value: String(form.enabled) },
          { namespace: NAMESPACE, key: "browser_notifications", value: String(form.browserNotifications) },
          { namespace: NAMESPACE, key: "max_file_bytes", value: mbToBytes(form.maxFileMB, 1) },
          { namespace: NAMESPACE, key: "user_quota_bytes", value: mbToBytes(form.quotaMB, 0) },
          { namespace: NAMESPACE, key: "retention_days", value: String(Math.max(0, Number.parseInt(form.retentionDays, 10) || 0)) },
        ],
      });
      setNotice(t("saved"));
      await load();
    } catch {
      setNotice(t("failed"));
    } finally {
      setSaving(false);
    }
  };

  return { t, form, setForm, status, loading, saving, notice, load, save };
}

function bytesToMB(value: string | undefined, fallback: string) {
  const bytes = Number(value);
  return Number.isFinite(bytes) ? String(Math.round(bytes / 1024 / 1024)) : fallback;
}

function mbToBytes(value: string, minimumMB: number) {
  const megabytes = Math.max(minimumMB, Number(value) || 0);
  return String(Math.round(megabytes * 1024 * 1024));
}
