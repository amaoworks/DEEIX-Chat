import assert from "node:assert/strict";
import { test } from "node:test";

import { safeInternalMessageMarkdown } from "./message-markdown.ts";

function assertNoLoadableImage(output) {
  assert.equal(typeof output, "string");
  assert.equal(/!\[[^\]]*\]/.test(output), false, `leftover image form: ${output}`);
  assert.equal(/<img\b/i.test(output), false, `leftover img tag: ${output}`);
  assert.equal(
    /\[[^\]]+\]:\s*https?:\/\//i.test(output),
    false,
    `leftover URL definition: ${output}`,
  );
}

test("shortcut reference to a third-party URL is neutralized", () => {
  const output = safeInternalMessageMarkdown(
    "see ![logo]\n\n[logo]: https://attacker.example/pixel.png",
  );
  assertNoLoadableImage(output);
  assert.equal(output.includes("logo"), true);
  assert.equal(output.includes("https://attacker.example/pixel.png"), false);
});

test("inline image is neutralized", () => {
  const output = safeInternalMessageMarkdown(
    "hi ![alt text](https://attacker.example/pixel.png) there",
  );
  assertNoLoadableImage(output);
  assert.equal(output.includes("alt text"), true);
  assert.equal(output.includes("https://attacker.example/pixel.png"), false);
});

test("collapsed reference image is neutralized", () => {
  const output = safeInternalMessageMarkdown(
    "![logo][]\n\n[logo]: https://attacker.example/pixel.png",
  );
  assertNoLoadableImage(output);
  assert.equal(output.includes("logo"), true);
  assert.equal(output.includes("https://attacker.example/pixel.png"), false);
});

test("full reference image is neutralized", () => {
  const output = safeInternalMessageMarkdown(
    "![Company logo][logo]\n\n[logo]: https://attacker.example/pixel.png",
  );
  assertNoLoadableImage(output);
  assert.equal(output.includes("Company logo"), true);
  assert.equal(output.includes("https://attacker.example/pixel.png"), false);
});

test("raw img tag is neutralized", () => {
  const output = safeInternalMessageMarkdown(
    'before <img src="https://attacker.example/pixel.png" alt="tracker"> after',
  );
  assertNoLoadableImage(output);
  assert.equal(output.includes("https://attacker.example/pixel.png"), false);
});

test("angle-bracket inline destination and multiline img are neutralized", () => {
  const output = safeInternalMessageMarkdown(
    "![logo](<https://attacker.example/pixel.png>)\n<img\n  src='https://attacker.example/pixel.png'\n  alt='x'>",
  );
  assertNoLoadableImage(output);
  assert.equal(output.includes("https://attacker.example/pixel.png"), false);
});
