// @ts-check

import { fileURLToPath } from "node:url";
import { unified } from "@astrojs/markdown-remark";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { rehypeRepoLinks } from "./src/lib/rehype-repo-links.ts";

export default defineConfig({
  site: "https://httpeers.com",
  // Astro's HTML compression drops the line break between text and an inline element on the next
  // line ("describes what\n<a>…" renders "describes what…" with no space), across every hand-written
  // page. The served files are brotli/gzip copies (scripts/compress.mjs), so the whitespace costs
  // next to nothing on the wire.
  compressHTML: false,
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // The theme CodeBlock uses, so code reads the same in Markdown pages and hand-written ones.
    shikiConfig: { theme: "github-dark-default" },
    // The repository's Markdown (README files, docs/security-model.md) is rendered as pages; its
    // relative links are written for GitHub and rewritten for the site (rehypeRepoLinks).
    processor: unified({
      rehypePlugins: [[rehypeRepoLinks, { root: fileURLToPath(new URL("..", import.meta.url)) }]],
    }),
  },
});
