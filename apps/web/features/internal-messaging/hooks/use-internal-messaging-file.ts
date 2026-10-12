"use client";
import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { downloadInternalMessagingFile } from "@/shared/api/internal-messaging";
import type { InternalMessagingMessage } from "@/shared/api/internal-messaging-types";

export function useInternalMessagingFile({
  accessToken,
  message,
  onError,
}: {
  accessToken: string;
  message: InternalMessagingMessage;
  onError: () => void;
}) {
  const t = useTranslations("internalMessaging");
  const locale = useLocale();
  const [imageURL, setImageURL] = React.useState("");
  const [shouldLoadImage, setShouldLoadImage] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const file = message.file;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    if (!file?.image || shouldLoadImage) return;
    const element = containerRef.current;
    if (!element || !("IntersectionObserver" in window)) {
      setShouldLoadImage(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoadImage(true);
        observer.disconnect();
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [file?.image, shouldLoadImage]);

  React.useEffect(() => {
    if (!file?.image || !shouldLoadImage) return;
    let disposed = false;
    let objectURL = "";
    void downloadInternalMessagingFile(accessToken, message.id, { thumbnail: true })
      .then((blob) => {
        if (disposed) return;
        objectURL = URL.createObjectURL(blob);
        setImageURL(objectURL);
      })
      .catch(() => {
        if (!disposed) onErrorRef.current();
      });
    return () => {
      disposed = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [accessToken, file?.image, message.id, shouldLoadImage]);

  const download = async () => {
    if (!file) return;
    try {
      const blob = await downloadInternalMessagingFile(accessToken, message.id, { download: true });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      onError();
    }
  };

  return { t, locale, imageURL, containerRef, file, download };
}
