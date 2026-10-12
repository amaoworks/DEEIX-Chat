"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { downloadInternalMessagingFile } from "@/shared/api/internal-messaging";
import type { InternalMessagingMessage } from "@/shared/api/internal-messaging-types";

export function useInternalMessagingPreview({
  accessToken,
  message,
  onClose,
  onError,
}: {
  accessToken: string;
  message: InternalMessagingMessage;
  onClose: () => void;
  onError: () => void;
}) {
  const t = useTranslations("internalMessaging");
  const [imageURL, setImageURL] = React.useState("");
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    let disposed = false;
    let objectURL = "";
    void downloadInternalMessagingFile(accessToken, message.id)
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
  }, [accessToken, message.id]);

  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return { t, imageURL };
}
