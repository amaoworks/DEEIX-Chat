"use client";

import { StreamdownRender } from "@/shared/components/markdown/streamdown-render";

export function InternalMessageMarkdown({
  content,
  className,
}: {
  content: string;
  className: string;
}) {
  return (
    <StreamdownRender
      content={content}
      streaming={false}
      variant="user"
      className={className}
    />
  );
}
