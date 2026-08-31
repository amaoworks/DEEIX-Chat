function findClosing(
  content: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\\" && index + 1 < content.length) {
      index += 1;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseMarkdownImage(
  content: string,
  start: number,
): { alt: string; end: number } | null {
  if (content[start] !== "!" || content[start + 1] !== "[") return null;
  const altEnd = findClosing(content, start + 1, "[", "]");
  if (altEnd < 0) return null;
  const alt = content.slice(start + 2, altEnd);
  let index = altEnd + 1;
  while (content[index] === " " || content[index] === "\t") index += 1;
  if (content[index] === "(") {
    const destEnd = findClosing(content, index, "(", ")");
    if (destEnd < 0) return null;
    return { alt, end: destEnd + 1 };
  }
  if (content[index] === "[") {
    const refEnd = findClosing(content, index, "[", "]");
    if (refEnd < 0) return null;
    return { alt, end: refEnd + 1 };
  }
  return { alt, end: altEnd + 1 };
}

function stripMarkdownImages(content: string): string {
  let output = "";
  for (let index = 0; index < content.length; index += 1) {
    if (
      content[index] === "!" &&
      content[index + 1] === "[" &&
      content[index - 1] !== "\\"
    ) {
      const parsed = parseMarkdownImage(content, index);
      if (parsed) {
        output += parsed.alt;
        index = parsed.end - 1;
        continue;
      }
    }
    output += content[index];
  }
  return output
    .replace(/!\[([^\]]*)\]\((?:<[^>]*>|(?:\\.|[^)])*)\)/g, "$1")
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/!\[([^\]]*)\]/g, "$1");
}

function stripLinkReferenceDefinitions(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S/.test(line))
    .join("\n");
}

// Authenticated attachments render through MessageFile, not Markdown images.
// Neutralize image syntax and URL definitions so Streamdown cannot request them.
export function safeInternalMessageMarkdown(content: string) {
  return stripLinkReferenceDefinitions(
    stripMarkdownImages(content.replace(/<img\b[\s\S]*?>/gi, "")),
  );
}
