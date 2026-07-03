#!/usr/bin/env node

const lines = [
  "delve installed.",
  "",
  "Next setup commands:",
  "  delve init",
  "  delve codex install-skill",
  "  delve set auth coral",
  "  delve set auth exa",
  "  delve model select",
  "  delve --json doctor",
  ""
];

process.stdout.write(lines.join("\n"));
