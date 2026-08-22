"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

export function AdminInternalMessagingPage() {
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <ToggleRow label={t("enabled")} checked={form.enabled} onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))} />
          <ToggleRow label={t("notifications")} checked={form.browserNotifications} onCheckedChange={(browserNotifications) => setForm((current) => ({ ...current, browserNotifications }))} />
          <div className="grid gap-4 md:grid-cols-3">
            <NumberField label={t("maxFileMB")} value={form.maxFileMB} min="1" max="100" onChange={(maxFileMB) => setForm((current) => ({ ...current, maxFileMB }))} />
            <NumberField label={t("quotaMB")} value={form.quotaMB} min="0" onChange={(quotaMB) => setForm((current) => ({ ...current, quotaMB }))} />
            <NumberField label={t("retentionDays")} value={form.retentionDays} min="0" max="3650" onChange={(retentionDays) => setForm((current) => ({ ...current, retentionDays }))} />
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={loading || saving} onClick={() => void save()}>{saving ? t("saving") : t("save")}</Button>
            {notice ? <span className="text-sm text-muted-foreground">{notice}</span> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="grid-cols-[1fr_auto]">
          <div>
            <CardTitle>{t("runtime")}</CardTitle>
            <CardDescription>{status?.enabled ? t("enabled") : t("configured")}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? "animate-spin" : ""} /></Button>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label={t("configured")} value={yesNo(status?.configured)} />
          <Metric label={t("healthy")} value={yesNo(status?.healthy)} />
          <Metric label={t("activeSSE")} value={status?.activeSSE ?? 0} />
          <Metric label={t("latency")} value={`${status?.averageLatencyMS ?? 0} ms`} />
          <Metric label={t("requests")} value={status?.voceRequests ?? 0} />
          <Metric label={t("failures")} value={status?.voceFailures ?? 0} />
          <Metric label={t("messages")} value={status?.indexedMessages ?? 0} />
          <Metric label={t("files")} value={formatBytes(status?.fileBytes ?? 0)} />
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-sm font-medium">{label}</span><Switch checked={checked} onCheckedChange={onCheckedChange} /></div>;
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: string; min: string; max?: string; onChange: (value: string) => void }) {
  return <div><Label>{label}</Label><Input type="number" value={value} min={min} max={max} onChange={(event) => onChange(event.target.value)} /></div>;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>;
}

function bytesToMB(value: string | undefined, fallback: string) {
  const bytes = Number(value);
  return Number.isFinite(bytes) ? String(Math.round(bytes / 1024 / 1024)) : fallback;
}

function mbToBytes(value: string, minimumMB: number) {
  const megabytes = Math.max(minimumMB, Number(value) || 0);
  return String(Math.round(megabytes * 1024 * 1024));
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function yesNo(value: boolean | undefined) {
  return value ? "✓" : "—";
}
