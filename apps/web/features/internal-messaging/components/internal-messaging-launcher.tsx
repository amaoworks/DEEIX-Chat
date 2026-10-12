"use client";

import { useInternalMessagingLauncher } from "../hooks/use-internal-messaging-launcher";

import * as React from "react";


import { InternalMessagingLauncherButton } from "./internal-messaging-launcher-button";

function createLazyInternalMessagingWindow() {
  return React.lazy(async () => {
    const module = await import("./internal-messaging-host");
    return { default: module.InternalMessagingWindowHost };
  });
}

class MessagingWindowBoundary extends React.Component<
  {
    children: React.ReactNode;
    fallback: React.ReactNode;
    onError?: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}


export function InternalMessagingHost() {
  const {
    t,
    user,
    status,
    activated,
    setWindowLoadFailed,
    loadAttempt,
    open,
    retryWindowLoad,
  } = useInternalMessagingLauncher();

  const LazyInternalMessagingWindow = React.useMemo(createLazyInternalMessagingWindow, [loadAttempt]);

  if (activated && status) {
    return (
      <MessagingWindowBoundary
        key={`${user?.publicID || "signed-out"}:${loadAttempt}`}
        onError={() => setWindowLoadFailed(true)}
        fallback={
          <LauncherLoadFailure
            key={user?.publicID}
            accountID={user?.publicID || ""}
            unreadCount={status.unreadCount}
            label={t("aria.open")}
            errorMessage={t("errors.windowLoad")}
            retryLabel={t("actions.retryLoad")}
            onOpen={retryWindowLoad}
          />
        }
      >
        <React.Suspense
          fallback={
            <InternalMessagingLauncherButton
              key={user?.publicID}
              accountID={user?.publicID || ""}
              unreadCount={status.unreadCount}
              label={t("aria.open")}
              onOpen={open}
            />
          }
        >
          <LazyInternalMessagingWindow initiallyOpen initialStatus={status} />
        </React.Suspense>
      </MessagingWindowBoundary>
    );
  }
  if (!status?.enabled || !user) return null;

  return (
    <InternalMessagingLauncherButton
      key={user.publicID}
      accountID={user.publicID}
      unreadCount={status.unreadCount}
      label={t("aria.open")}
      onOpen={open}
    />
  );
}

function LauncherLoadFailure({
  errorMessage,
  retryLabel,
  ...buttonProps
}: React.ComponentProps<typeof InternalMessagingLauncherButton> & {
  errorMessage: string;
  retryLabel: string;
}) {
  return (
    <>
      <div
        className="fixed bottom-20 right-5 z-[70] max-w-64 rounded-md border bg-background p-3 text-sm shadow-lg"
        role="alert"
      >
        <p>{errorMessage}</p>
        <p className="mt-1 text-xs text-muted-foreground">{retryLabel}</p>
      </div>
      <InternalMessagingLauncherButton {...buttonProps} label={retryLabel} />
    </>
  );
}
