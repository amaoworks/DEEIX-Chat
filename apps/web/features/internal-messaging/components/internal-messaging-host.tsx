"use client";
import { useInternalMessagingPreview } from "../hooks/use-internal-messaging-preview";
import { useInternalMessagingFile } from "../hooks/use-internal-messaging-file";

import { useInternalMessagingWindow } from "../hooks/use-internal-messaging-window";

import { displayName, formatFileSize } from "../model/message-format";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  CornerUpLeft,
  Download,
  FileIcon,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minus,
  Paperclip,
  Pencil,
  Pin,
  Search,
  Send,
  Smile,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { safeInternalMessageMarkdown } from "@/features/internal-messaging/model/message-markdown";
import { messageRowContainmentStyle } from "@/features/internal-messaging/model/message-row-visibility";
import { cn } from "@/lib/utils";
import type {
  InternalMessagingMessage,
  InternalMessagingStatus,
  InternalMessagingUser,
} from "@/shared/api/internal-messaging-types";
import { resolveAvatarImageSrc } from "@/shared/lib/avatar";

import { RESIZE_HANDLES } from "./use-messaging-window-layout";
import { InternalMessagingLauncherButton } from "./internal-messaging-launcher-button";
import { shouldSendOnEnter } from "../model/message-composer";
import {
  formatMessageHoverLabel,
  formatTime,
} from "../model/message-time";

const LazyInternalMessageMarkdown = React.lazy(async () => {
  const module = await import("./internal-message-markdown");
  return { default: module.InternalMessageMarkdown };
});

import type { MessageFocusRequest, MessageScrollAnchor } from "../hooks/use-internal-messaging-window";
class MessageRenderBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const MessagingWindowOpenContext = React.createContext(false);
const EMOJI_PAGES = [
  [
    "😀", "😃", "😄", "😁", "😂", "😊", "😍", "🥰",
    "😘", "😎", "🤔", "😅", "😭", "😡", "🥳", "🤩",
    "👍", "👎", "👏", "🙏", "💪", "👌", "✌️", "🤝",
    "❤️", "💔", "🔥", "🎉", "✨", "💯", "✅", "🚀",
  ],
  [
    "🙃", "😉", "😌", "😋", "😜", "🤗", "🤭", "🤫",
    "🤨", "🧐", "😏", "😴", "🤤", "🤯", "🥺", "😱",
    "😳", "🥶", "🥵", "🤢", "🤮", "🤧", "🤒", "🤕",
    "👀", "🙈", "🙉", "🙊", "🐱", "🐶", "☕", "🎂",
  ],
] as const;

function initials(value: string) {
  return value.trim().slice(0, 2).toUpperCase() || "?";
}

const MessagingAvatar = React.memo(function MessagingAvatar({
  user,
  className,
}: {
  user: InternalMessagingUser;
  className?: string;
}) {
  const imageSrc = resolveAvatarImageSrc(user.avatarURL, user) || undefined;
  const [failedImageSrc, setFailedImageSrc] = React.useState<string>();
  const showInitials = !imageSrc || failedImageSrc === imageSrc;

  return (
    <Avatar className={className}>
      <AvatarImage
        src={imageSrc}
        alt={displayName(user)}
        className="object-cover"
        onLoadingStatusChange={(status) => {
          if (status === "error") setFailedImageSrc(imageSrc);
          if (status === "loaded") setFailedImageSrc(undefined);
        }}
      />
      <AvatarFallback>
        {showInitials ? initials(displayName(user)) : null}
      </AvatarFallback>
    </Avatar>
  );
});

export function InternalMessagingWindowHost({
  initiallyOpen = false,
  initialStatus,
}: {
  initiallyOpen?: boolean;
  initialStatus?: InternalMessagingStatus;
}) {
  const {
    t,
    locale,
    accessToken,
    user,
    pendingDeleteMessage,
    setPendingDeleteMessage,
    enabled,
    open,
    setOpen,
    mobileLayout,
    expanded,
    setExpanded,
    windowBounds,
    startWindowDrag,
    moveWindow,
    stopWindowDrag,
    startResize,
    resizeWindow,
    stopResize,
    users,
    conversations,
    directoryView,
    setDirectoryView,
    query,
    setQuery,
    hasMoreUsers,
    selected,
    setSelected,
    messages,
    loadingUsers,
    loadingMessages,
    loadingOlderMessages,
    hasMoreMessages,
    nextBefore,
    unreadByUser,
    totalUnread,
    messageSearchOpen,
    setMessageSearchOpen,
    messageSearchQuery,
    setMessageSearchQuery,
    messageSearchResults,
    searchingMessages,
    revealedTimestampID,
    setRevealedTimestampID,
    directoryError,
    messageError,
    actionError,
    setActionError,
    newMessagesBelow,
    messageFocusRequest,
    draggingFile,
    setDraggingFile,
    previewMessage,
    setPreviewMessage,
    emojiPickerOpen,
    setEmojiPickerOpen,
    emojiPage,
    setEmojiPage,
    connected,
    presenceReady,
    onlineByUser,
    windowRef,
    emojiPopoverRef,
    windowOpenRef,
    restoringAnchorRef,
    fileInputRef,
    composerRef,
    messageViewportRef,
    reconnectHistoryRef,
    historyRequiredRef,
    nearMessageBottomRef,
    pendingMessageScrollRef,
    scrollToMessageBottom,
    maintainMessageBottom,
    messageByID,
    handleMessageScroll,
    conversationList,
    loadConversations,
    composer,
    draft,
    setDraft,
    replyTo,
    setReplyTo,
    editing,
    setEditing,
    send,
    sending,
    uploading,
    acknowledgeVisibleMessages,
    loadUsers,
    loadMessages,
    prefetchMessages,
    selectUser,
    notificationState,
    toggleNotifications,
    updateConversationPreference,
    searchMessages,
    minimize,
    chooseEdit,
    removeMessage,
    uploadFile,
    pasteFile,
    dropFile,
    insertEmoji,
    focusSearchResult,
  } = useInternalMessagingWindow({ initiallyOpen, initialStatus });

  if (!enabled || !user) return null;

  return (
    <MessagingWindowOpenContext value={open}>
      <AlertDialog open={pendingDeleteMessage !== null} onOpenChange={(next) => { if (!next) setPendingDeleteMessage(null); }}>
        <AlertDialogContent className="z-[110]" overlayClassName="z-[105]" aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("messages.confirmDelete")}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("aria.cancelAction")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (pendingDeleteMessage) void removeMessage(pendingDeleteMessage);
              setPendingDeleteMessage(null);
            }}>{t("messages.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
        <aside
          ref={windowRef}
          inert={!open}
          aria-hidden={!open}
          data-messaging-window
          className={cn(
            "fixed z-[70] flex min-h-0 flex-col overflow-hidden bg-background shadow-2xl overscroll-contain",
            mobileLayout ? "inset-0 rounded-none border-0" : "rounded-2xl border",
            // Hide the entire subtree immediately, including buttons that transition visibility.
            !open && "invisible pointer-events-none opacity-0",
          )}
          style={
            mobileLayout
              ? { width: "100%", height: "100dvh" }
              : expanded ? { left: "5vw", top: "5dvh", width: "90vw", height: "90dvh" } : {
                  left: windowBounds.x,
                  top: windowBounds.y,
                  width: windowBounds.width,
                  height: windowBounds.height,
                }
          }
        >
          <header
            className={cn(
              "flex min-h-14 shrink-0 select-none items-center gap-2 border-b px-3",
              mobileLayout
                ? "cursor-default touch-auto pt-[env(safe-area-inset-top)]"
                : "h-14 cursor-move touch-none",
            )}
            onPointerDown={expanded ? undefined : startWindowDrag}
            onPointerMove={moveWindow}
            onPointerUp={stopWindowDrag}
            onPointerCancel={stopWindowDrag}
          >
            {selected ? (
              <HeaderIconButton label={t("aria.back")} onClick={() => setSelected(null)}>
                <ChevronLeft />
              </HeaderIconButton>
            ) : (
              <MessageCircle className="size-4 text-primary" />
            )}
            {selected ? <MessagingAvatar user={selected} /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {selected ? displayName(selected) : t("title")}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {selected
                  ? presenceReady
                    ? `${selected.username} · ${t(onlineByUser[selected.publicID] ? "presence.online" : "presence.offline")}`
                    : selected.username
                  : t(mobileLayout ? "mobileHint" : "dragHint")}
              </p>
            </div>
            {!mobileLayout ? (
              <HeaderIconButton
                label={t(expanded ? "aria.restore" : "aria.expand")}
                onClick={() => setExpanded((value) => !value)}
              >
                <Maximize2 />
              </HeaderIconButton>
            ) : null}
            {selected ? (
              <HeaderIconButton
                label={t("aria.search")}
                onClick={() => setMessageSearchOpen((current) => !current)}
              >
                <Search />
              </HeaderIconButton>
            ) : null}
            <HeaderIconButton
              label={t(`aria.${notificationState.tooltipKey}`)}
              disabled={notificationState.disabled}
              onClick={() => void toggleNotifications()}
            >
              {notificationState.active ? <Bell /> : <BellOff />}
            </HeaderIconButton>
            <HeaderIconButton label={t("aria.minimize")} onClick={minimize}>
              <Minus />
            </HeaderIconButton>
          </header>

          {!connected ? <p role="status" className="border-b bg-muted px-3 py-2 text-xs">{t("connection.reconnecting")}</p> : null}
          {actionError ? (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span className="min-w-0 flex-1">{actionError}</span>
              <button
                type="button"
                aria-label={t("aria.dismissError")}
                className="rounded p-0.5 hover:bg-destructive/10"
                onClick={() => setActionError("")}
              >
                <X className="size-3" />
              </button>
            </div>
          ) : null}

          {selected ? (
            <div
              className="relative flex min-h-0 flex-1 flex-col"
              onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setDraggingFile(true);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                setDraggingFile(false);
              }}
              onDrop={dropFile}
            >
              {messageSearchOpen ? (
                <div className="border-b p-2">
                  <div className="flex gap-2">
                    <Input
                      value={messageSearchQuery}
                      onChange={(event) => setMessageSearchQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void searchMessages();
                      }}
                      placeholder={t("search.placeholder")}
                    />
                    <Button
                      size="sm"
                      disabled={!messageSearchQuery.trim() || searchingMessages}
                      onClick={() => void searchMessages()}
                    >
                      {searchingMessages ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        t("search.action")
                      )}
                    </Button>
                  </div>
                  {messageSearchResults.length > 0 ? (
                    <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                      {messageSearchResults.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                          onClick={() => void focusSearchResult(item)}
                        >
                          {item.content}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div
                ref={messageViewportRef}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 overscroll-contain"
                onScroll={handleMessageScroll}
                onPointerDownCapture={() => { restoringAnchorRef.current = null; }}
                onWheelCapture={() => { restoringAnchorRef.current = null; }}
                onKeyDownCapture={() => { restoringAnchorRef.current = null; }}
              >
                {messageError ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                  >
                    <span>{messageError}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={loadingMessages}
                      onClick={() => void loadMessages(selected.publicID)}
                    >
                      {t("actions.retryLoad")}
                    </Button>
                  </div>
                ) : null}
                {hasMoreMessages ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={loadingOlderMessages}
                    onClick={() => void loadMessages(selected.publicID, nextBefore)}
                  >
                    {loadingOlderMessages ? t("messages.loading") : t("messages.loadOlder")}
                  </Button>
                ) : null}
                {loadingMessages && messages.length === 0 ? (
                  <Loading />
                ) : messages.length === 0 ? (
                  composer.outgoing.length === 0 && !messageError ? <Empty label={t("messages.empty")} /> : null
                ) : (
                  <MessageRows
                    active={open}
                    followBottom={open && !reconnectHistoryRef.current}
                    messages={messages}
                    viewportRef={messageViewportRef}
                    followBottomRef={nearMessageBottomRef}
                    restoringAnchorRef={restoringAnchorRef}
                    focusRequest={messageFocusRequest}
                  >
                    {(message) => {
                    const mine = message.fromUserPublicID === user.publicID;
                    const hoverTime = formatMessageHoverLabel(
                      message.createdAt,
                      locale,
                      {
                        yesterday: t("time.yesterday"),
                        edited: t("messages.edited"),
                      },
                      Boolean(message.editedAt && !message.deleted),
                    );
                    return (
                      <div
                        id={`internal-message-${message.id}`}
                        data-message-id={message.id}
                        className={cn("flex w-full items-start gap-2", mine ? "justify-end" : "justify-start")}
                        style={messageRowContainmentStyle({
                          loadingOlderMessages,
                          preservingOlderScroll:
                            pendingMessageScrollRef.current?.mode === "preserve",
                        })}
                      >
                        {!mine ? <MessagingAvatar user={selected} className="size-7 text-xs" /> : null}
                        <div
                          className="group/message relative max-w-[min(85%,calc(100%-9rem))]"
                          onPointerUp={(event) => {
                            if (event.pointerType === "mouse") return;
                            if (event.target instanceof Element && event.target.closest("button, a")) return;
                            setRevealedTimestampID((current) =>
                              current === message.id ? null : message.id,
                            );
                          }}
                        >
                          <div
                            className={cn(
                              "rounded-2xl px-3 py-2 text-sm",
                              mine ? "bg-primary text-primary-foreground" : "bg-muted",
                            )}
                          >
                          {message.replyToID > 0 ? (
                            <div
                              className={cn(
                                "mb-1 border-l-2 pl-2 text-xs opacity-75",
                                mine ? "border-primary-foreground/50" : "border-foreground/30",
                              )}
                            >
                              {messageByID.get(message.replyToID)?.content ||
                                t("messages.olderReply")}
                            </div>
                          ) : null}
                          <MessageRenderBoundary
                            key={`${message.id}:${message.editedAt}:${message.deleted}`}
                            fallback={
                              <p className="italic opacity-70">{t("messages.renderError")}</p>
                            }
                          >
                            {message.deleted ? (
                              <p className="italic opacity-70">{t("messages.deleted")}</p>
                            ) : message.file ? (
                              <MessageFile
                                accessToken={accessToken}
                                message={message}
                                onError={() => setActionError(t("errors.fileDownload"))}
                                onContentResize={maintainMessageBottom}
                                onPreview={() => setPreviewMessage(message)}
                              />
                            ) : (
                              <React.Suspense
                                fallback={
                                  <p className="whitespace-pre-wrap break-words text-sm">
                                    {message.content}
                                  </p>
                                }
                              >
                                <LazyInternalMessageMarkdown
                                  content={safeInternalMessageMarkdown(message.content)}
                                className={cn(
                                  "break-words text-sm [&_a]:underline [&_a]:underline-offset-2 [&_p]:my-0",
                                  mine &&
                                    "text-primary-foreground [&_a]:text-primary-foreground",
                                )}
                                />
                              </React.Suspense>
                            )}
                          </MessageRenderBoundary>
                          </div>
                          {hoverTime ? (
                            <time
                              dateTime={message.createdAt}
                              className={cn(
                                "pointer-events-none absolute bottom-1 max-w-[6.75rem] text-[10px] leading-tight text-muted-foreground transition-opacity",
                                revealedTimestampID === message.id
                                  ? "opacity-100"
                                  : "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
                                mine
                                  ? "right-full mr-1.5 text-right"
                                  : "left-full ml-1.5 text-left",
                              )}
                            >
                              {hoverTime}
                            </time>
                          ) : null}
                          {!message.deleted ? (
                            <span
                            className={cn(
                                "absolute -top-3 hidden items-center rounded-full border bg-background text-foreground shadow-sm group-hover/message:flex group-focus-within/message:flex max-sm:flex",
                                mine ? "right-1" : "left-1",
                            )}
                          >
                              {message.content ? (
                                <MessageAction label={t("messages.copy")} onClick={() => void navigator.clipboard.writeText(message.content)}>
                                  <Clipboard className="size-3" />
                                </MessageAction>
                              ) : null}
                              <MessageAction label={t("messages.reply")} onClick={() => { setReplyTo(message); setEditing(null); }}>
                                <CornerUpLeft className="size-3" />
                              </MessageAction>
                              {mine && !message.file ? (
                                <MessageAction label={t("messages.edit")} onClick={() => chooseEdit(message)}>
                                  <Pencil className="size-3" />
                                </MessageAction>
                              ) : null}
                              {mine ? (
                                <MessageAction label={t("messages.delete")} onClick={() => setPendingDeleteMessage(message)}>
                                  <Trash2 className="size-3" />
                                </MessageAction>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                        {mine ? <MessagingAvatar user={user} className="size-7 text-xs" /> : null}
                      </div>
                    );
                    }}
                  </MessageRows>
                )}
                {composer.outgoing.map((item) => (
                  <div key={item.id} className="flex items-start justify-end gap-2">
                    <div className="max-w-[min(85%,calc(100%-9rem))] rounded-2xl bg-primary/10 px-3 py-2 text-sm">
                      <p className="whitespace-pre-wrap break-words">{item.content}</p>
                      <div className="mt-1 flex items-center gap-2 text-xs" role="status">
                        <span>{t(item.status === "sending" ? "messages.sending" : "messages.failed")}</span>
                        {item.status === "failed" ? <>
                          <Button size="sm" variant="ghost" onClick={() => void composer.retry(item.id)}>{t("messages.retry")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => composer.discard(item.id)}>{t("messages.discard")}</Button>
                        </> : null}
                      </div>
                    </div>
                    <MessagingAvatar user={user} className="size-7 text-xs" />
                  </div>
                ))}
              </div>
              {newMessagesBelow ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="absolute bottom-20 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg"
                  onClick={() => {
                    if ((reconnectHistoryRef.current || historyRequiredRef.current) && selected) {
                      nearMessageBottomRef.current = true;
                      void loadMessages(selected.publicID);
                    } else {
                      scrollToMessageBottom("smooth");
                      acknowledgeVisibleMessages();
                    }
                  }}
                >
                  <ChevronDown className="size-3" />
                  {t("messages.newBelow")}
                </Button>
              ) : null}
              <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {[...draft.trim()].length > 4000 ? <p role="alert" className="text-xs text-destructive">{t("composer.tooLong")}</p> : null}
                {replyTo || editing ? (
                  <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                    {editing ? <Pencil className="size-3" /> : <CornerUpLeft className="size-3" />}
                    <span className="min-w-0 flex-1 truncate">
                      {editing
                        ? t("composer.editing")
                        : t("composer.replying", {
                            content:
                              replyTo?.content || replyTo?.file?.name || t("composer.file"),
                          })}
                    </span>
                    <button
                      type="button"
                      aria-label={t("aria.cancelAction")}
                      onClick={() => {
                        setReplyTo(null);
                        setEditing(null);
                        if (editing) setDraft("");
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : null}
                <div className="flex items-end gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadFile(file);
                    }}
                  />
                  <Button
                    aria-label={t("aria.attach")}
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={uploading || sending || Boolean(editing)}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
                  </Button>
                  <Popover open={open && emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        aria-label={t("aria.emoji")}
                        type="button"
                        variant="ghost"
                        size="icon"
                      >
                        <Smile />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      ref={emojiPopoverRef}
                      onCloseAutoFocus={(event) => {
                        if (!windowOpenRef.current) event.preventDefault();
                      }}
                      side="top"
                      align="start"
                      className="z-[80] w-64 p-2"
                    >
                      <div className="grid grid-cols-8 gap-1">
                        {EMOJI_PAGES[emojiPage].map((emoji) => (
                          <button
                            type="button"
                            key={emoji}
                            className="flex h-7 w-full items-center justify-center rounded text-lg hover:bg-accent focus-visible:bg-accent"
                            onClick={() => insertEmoji(emoji)}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between border-t pt-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("emoji.previousPage")}
                          disabled={emojiPage === 0}
                          onClick={() => setEmojiPage((page) => Math.max(0, page - 1))}
                        >
                          <ChevronLeft />
                        </Button>
                        <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                          {t("emoji.page", { current: emojiPage + 1, total: EMOJI_PAGES.length })}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("emoji.nextPage")}
                          disabled={emojiPage === EMOJI_PAGES.length - 1}
                          onClick={() => setEmojiPage((page) => Math.min(EMOJI_PAGES.length - 1, page + 1))}
                        >
                          <ChevronRight />
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onPaste={pasteFile}
                    onKeyDown={(event) => {
                      if (shouldSendOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    aria-label={t("composer.placeholder")}
                    placeholder={t("composer.placeholder")}
                    className="max-h-28 min-h-10 resize-none text-base sm:text-sm"
                  />
                  <Button
                    aria-label={t("aria.send")}
                    size="icon"
                    disabled={!draft.trim() || [...draft.trim()].length > 4000}
                    onClick={() => void send()}
                  >
                    {sending ? <LoaderCircle className="animate-spin" /> : editing ? <Check /> : <Send />}
                  </Button>
                </div>
              </div>
              {draggingFile ? (
                <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 text-sm font-medium text-primary backdrop-blur-sm">
                  {t("composer.dropFile")}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="space-y-2 border-b p-3">
                <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1 text-xs",
                      directoryView === "recent" && "bg-background font-medium shadow-sm",
                    )}
                    onClick={() => setDirectoryView("recent")}
                  >
                    {t("directory.recent")}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1 text-xs",
                      directoryView === "users" && "bg-background font-medium shadow-sm",
                    )}
                    onClick={() => setDirectoryView("users")}
                  >
                    {t("directory.allUsers")}
                  </button>
                </div>
                {directoryView === "users" ? (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("directory.searchPlaceholder")}
                      className="pl-8"
                    />
                  </div>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {directoryView === "recent" && conversationList.failed ? <p role="alert" className="text-xs text-destructive">{t("errors.directory")}<Button variant="ghost" onClick={() => void loadConversations()}>{t("messages.retry")}</Button></p> : null}
                {directoryView === "recent" ? (
                  conversationList.loading && conversations.length === 0 ? <Loading /> : conversations.length === 0 ? (
                    <Empty label={t("directory.noRecent")} />
                  ) : (
                    conversations.map((conversation) => {
                      const item = conversation.user;
                      const unread = unreadByUser[item.publicID] ?? conversation.unreadCount;
                      return (
                        <div
                          key={item.publicID}
                          className="group/conversation flex items-center rounded-lg hover:bg-accent"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left"
                            onClick={() => selectUser(item)}
                            onPointerEnter={() => prefetchMessages(item)}
                            onFocus={() => prefetchMessages(item)}
                            onTouchStart={() => prefetchMessages(item)}
                          >
                            <span className="relative shrink-0">
                              <MessagingAvatar user={item} />
                              {presenceReady ? (
                                <PresenceIndicator
                                  online={Boolean(onlineByUser[item.publicID])}
                                  label={t(
                                    onlineByUser[item.publicID]
                                      ? "presence.online"
                                      : "presence.offline",
                                  )}
                                />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1">
                                <span className="truncate text-sm font-medium">
                                  {displayName(item)}
                                </span>
                                {conversation.pinned ? (
                                  <IconTooltip label={t("aria.pinned")}>
                                    <span
                                      className="inline-flex"
                                      role="img"
                                      aria-label={t("aria.pinned")}
                                    >
                                      <Pin className="size-3 text-primary" />
                                    </span>
                                  </IconTooltip>
                                ) : null}
                                {conversation.muted ? (
                                  <IconTooltip label={t("aria.muted")}>
                                    <span
                                      className="inline-flex"
                                      role="img"
                                      aria-label={t("aria.muted")}
                                    >
                                      <VolumeX className="size-3 text-muted-foreground" />
                                    </span>
                                  </IconTooltip>
                                ) : null}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {conversation.lastMessagePreview || t("directory.start")}
                              </span>
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1">
                              <span className="text-[10px] text-muted-foreground">
                                {formatTime(conversation.lastMessageAt, locale)}
                              </span>
                              {unread > 0 ? (
                                <span className="flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
                                  {unread > 99 ? "99+" : unread}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          <span className="mr-1 hidden shrink-0 group-hover/conversation:flex group-focus-within/conversation:flex max-sm:flex">
                            <IconTooltip
                              label={conversation.pinned ? t("aria.unpin") : t("aria.pin")}
                            >
                              <button
                                type="button"
                                aria-label={
                                  conversation.pinned ? t("aria.unpin") : t("aria.pin")
                                }
                                className="rounded p-1 hover:bg-background"
                                onClick={() =>
                                  void updateConversationPreference(conversation, {
                                    pinned: !conversation.pinned,
                                  })
                                }
                              >
                                <Pin className="size-3" />
                              </button>
                            </IconTooltip>
                            <IconTooltip
                              label={conversation.muted ? t("aria.unmute") : t("aria.mute")}
                            >
                              <button
                                type="button"
                                aria-label={
                                  conversation.muted ? t("aria.unmute") : t("aria.mute")
                                }
                                className="rounded p-1 hover:bg-background"
                                onClick={() =>
                                  void updateConversationPreference(conversation, {
                                    muted: !conversation.muted,
                                  })
                                }
                              >
                                {conversation.muted ? (
                                  <Volume2 className="size-3" />
                                ) : (
                                  <VolumeX className="size-3" />
                                )}
                              </button>
                            </IconTooltip>
                          </span>
                        </div>
                      );
                    })
                  )
                ) : loadingUsers && users.length === 0 ? (
                  <Loading />
                ) : users.length === 0 ? (
                  <Empty label={directoryError || t("directory.noUsers")} />
                ) : (
                  <>
                    {directoryError ? (
                      <p
                        role="alert"
                        className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                      >
                        {directoryError}
                      </p>
                    ) : null}
                    {users.map((item) => {
                      const unread = unreadByUser[item.publicID] || 0;
                      return (
                        <button
                          type="button"
                          key={item.publicID}
                          className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-accent"
                          onClick={() => selectUser(item)}
                          onPointerEnter={() => prefetchMessages(item)}
                          onFocus={() => prefetchMessages(item)}
                          onTouchStart={() => prefetchMessages(item)}
                        >
                          <span className="relative shrink-0">
                            <MessagingAvatar user={item} />
                            {presenceReady ? (
                              <PresenceIndicator
                                online={Boolean(onlineByUser[item.publicID])}
                                label={t(
                                  onlineByUser[item.publicID]
                                    ? "presence.online"
                                    : "presence.offline",
                                )}
                              />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {displayName(item)}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.username}
                            </span>
                          </span>
                          {unread > 0 ? (
                            <span className="flex min-w-5 shrink-0 items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
                              {unread > 99 ? "99+" : unread}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {hasMoreUsers ? (
                      <Button
                        variant="ghost"
                        className="mt-1 w-full"
                        disabled={loadingUsers}
                        onClick={() => void loadUsers(false, true)}
                      >
                        {loadingUsers ? t("messages.loading") : t("directory.loadMore")}
                      </Button>
                    ) : null}
                  </>
                )}
                {directoryView === "recent" && conversationList.hasMore ? <Button variant="ghost" className="w-full" disabled={conversationList.loading} onClick={() => void loadConversations(true)}>{t(conversationList.loading ? "messages.loading" : "directory.loadMoreConversations")}</Button> : null}
              </div>
            </div>
          )}

          {!mobileLayout && !expanded
            ? RESIZE_HANDLES.map(({ direction, className }) => (
                <button
                  aria-label={t("aria.resize", { direction })}
                  type="button"
                  tabIndex={-1}
                  key={direction}
                  data-direction={direction}
                  className={cn(
                    "absolute z-10 touch-none border-0 bg-transparent p-0",
                    className,
                  )}
                  onPointerDown={startResize}
                  onPointerMove={resizeWindow}
                  onPointerUp={stopResize}
                  onPointerCancel={stopResize}
                />
              ))
            : null}
        </aside>

      {open && previewMessage ? (
        <ImageLightbox
          accessToken={accessToken}
          message={previewMessage}
          onClose={() => setPreviewMessage(null)}
          onError={() => setActionError(t("errors.fileDownload"))}
        />
      ) : null}

      {!open ? (
        <InternalMessagingLauncherButton
          key={user.publicID}
          accountID={user.publicID}
          unreadCount={totalUnread}
          label={t("aria.open")}
          onOpen={() => setOpen(true)}
        />
      ) : null}
    </MessagingWindowOpenContext>
  );
}

function MessageRows({
  active,
  followBottom,
  messages,
  viewportRef,
  followBottomRef,
  restoringAnchorRef,
  focusRequest,
  children,
}: {
  active: boolean;
  followBottom: boolean;
  messages: InternalMessagingMessage[];
  viewportRef: React.RefObject<HTMLDivElement | null>;
  followBottomRef: React.RefObject<boolean>;
  restoringAnchorRef: React.RefObject<MessageScrollAnchor | null>;
  focusRequest: MessageFocusRequest | null;
  children: (message: InternalMessagingMessage) => React.ReactNode;
}) {
  const enabled = messages.length > 120;
  const virtualizer = useVirtualizer({
    count: enabled ? messages.length : 0,
    enabled,
    estimateSize: () => 76,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => messages[index]?.id || index,
    overscan: 12,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualRows = virtualizer.getVirtualItems();
  React.useLayoutEffect(() => {
    // Estimated heights change again after rows mount. Follow those measurements
    // while at the tail, including the transition into virtual rendering.
    if (followBottom && enabled && followBottomRef.current && messages.length) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "auto" });
    }
  }, [enabled, followBottom, followBottomRef, focusRequest, messages.length, totalSize, virtualizer]);

  React.useLayoutEffect(() => {
    const anchor = restoringAnchorRef.current;
    const viewport = viewportRef.current;
    if (!active || !anchor || !viewport) return;
    const row = viewport.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`);
    if (row) {
      const delta = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) > 1) {
        if (enabled) virtualizer.scrollToOffset(viewport.scrollTop + delta);
        else viewport.scrollTop += delta;
      }
    } else if (enabled) {
      const index = messages.findIndex((message) => message.id === anchor.id);
      if (index < 0) return;
      const offset = virtualizer.getOffsetForIndex(index, "start");
      if (offset) virtualizer.scrollToOffset(offset[0] - anchor.offset);
    }
    // Keep correcting while virtual rows are measured, until the reader interacts again.
  }, [active, enabled, messages, restoringAnchorRef, totalSize, viewportRef, virtualizer, virtualRows]);

  const handledFocus = React.useRef<number | undefined>(undefined);
  React.useLayoutEffect(() => {
    if (!active || !focusRequest || handledFocus.current === focusRequest.sequence) return;
    const index = messages.findIndex((message) => message.id === focusRequest.id);
    if (index < 0) return;
    restoringAnchorRef.current = null;
    handledFocus.current = focusRequest.sequence;
    if (enabled) {
      virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
      return;
    }
    document.getElementById(`internal-message-${focusRequest.id}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [active, enabled, focusRequest, messages, restoringAnchorRef, virtualizer]);

  if (!enabled) {
    return <div className="space-y-3">{messages.map((message) => <React.Fragment key={message.id}>{children(message)}</React.Fragment>)}</div>;
  }

  return (
    <div className="relative w-full" style={{ height: totalSize }}>
      {virtualRows.map((virtualRow) => {
        const message = messages[virtualRow.index];
        if (!message) return null;
        return (
          <div
            key={message.id}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full pb-3"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {children(message)}
          </div>
        );
      })}
    </div>
  );
}

function Loading() {
  const t = useTranslations("internalMessaging");
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      <LoaderCircle className="mr-2 size-4 animate-spin" />
      {t("messages.loading")}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

function PresenceIndicator({ online, label }: { online: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "absolute bottom-0 right-0 size-3 rounded-full border-2 border-background",
        online ? "bg-emerald-500" : "bg-muted-foreground/50",
      )}
    />
  );
}

function HeaderIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const windowOpen = React.useContext(MessagingWindowOpenContext);
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            aria-label={label}
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      {windowOpen ? (
        <TooltipContent className="pointer-events-none z-[80]" side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  const windowOpen = React.useContext(MessagingWindowOpenContext);
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {windowOpen ? (
        <TooltipContent className="pointer-events-none z-[80]" side="top" sideOffset={6}>
          {label}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

function MessageAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded-full p-1.5 hover:bg-accent"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MessageFile({
  accessToken,
  message,
  onError,
  onContentResize,
  onPreview,
}: {
  accessToken: string;
  message: InternalMessagingMessage;
  onError: () => void;
  onContentResize: () => void;
  onPreview: () => void;
}) {
  const { t, locale, imageURL, containerRef, file, download } = useInternalMessagingFile({ accessToken, message, onError });
  if (!file) return null;

  return (
    <div ref={containerRef} className="block max-w-full text-left">
      {file.image && imageURL ? (
        <button type="button" className="group/image relative block" onClick={onPreview}>
          <img
            src={imageURL}
            loading="lazy"
            className="mb-1 max-h-56 max-w-full rounded-lg object-contain"
            alt={file.name}
            onLoad={onContentResize}
          />
          <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 opacity-0 transition group-hover/image:bg-black/25 group-hover/image:opacity-100">
            <Maximize2 className="size-5 text-white drop-shadow" />
          </span>
        </button>
      ) : (
        <button type="button" className="flex items-center gap-2" onClick={() => void download()}>
          <FileIcon className="size-8 shrink-0" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{file.name}</span>
            <span className="block text-xs opacity-70">
              {formatFileSize(file.size, locale, t("file.unknownSize"))}
            </span>
          </span>
          <Download className="size-4 shrink-0" />
        </button>
      )}
      {file.image && imageURL ? (
        <button
          type="button"
          className="flex w-full items-center gap-1 text-xs opacity-75"
          onClick={() => void download()}
        >
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <Download className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function ImageLightbox({
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
  const { t, imageURL } = useInternalMessagingPreview({ accessToken, message, onClose, onError });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("aria.imagePreview")}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4"
    >
      <button
        type="button"
        aria-label={t("aria.closePreview")}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <button
        type="button"
        aria-label={t("aria.closePreview")}
        className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
        onClick={onClose}
      >
        <X className="size-5" />
      </button>
      {imageURL ? (
        <img
          src={imageURL}
          alt={message.file?.name || ""}
          className="relative max-h-full max-w-full object-contain"
        />
      ) : (
        <LoaderCircle className="size-8 animate-spin text-white" />
      )}
    </div>
  );
}
