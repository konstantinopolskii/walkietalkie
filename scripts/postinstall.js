#!/usr/bin/env node
/* Copies the bits of @kk/design-system the popup needs into ./vendor/kk so
   the Chrome extension can ship them without runtime resolution. */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const src = path.resolve(root, "node_modules", "@kk", "design-system");
const dest = path.resolve(root, "vendor", "kk");

if (!fs.existsSync(src)) {
  console.warn("[talktrack] @kk/design-system not in node_modules; skipping vendor copy.");
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });

function copy(rel) {
  const from = path.join(src, rel);
  const to = path.join(dest, rel);
  if (!fs.existsSync(from)) return;
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const child of fs.readdirSync(from)) copy(path.join(rel, child));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

["vars.css", "style.css", "fonts"].forEach(copy);

console.log("[talktrack] vendored @kk/design-system into vendor/kk");
