import React, { useMemo, useCallback } from "react";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import hljs from "highlight.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-dark.css";
import "./MarkdownContent.css";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className }) => {
  const markedInstance = useMemo(() => {
    const m = new Marked({
      gfm: true,
      breaks: true,
    });

    // Attach KaTeX formula extension
    m.use(markedKatex({ throwOnError: false }));

    // Custom code block renderer with syntax highlighting and copy button
    m.use({
      renderer: {
        code({ text, lang }: { text: string; lang?: string }) {
          const rawCode = text ?? "";
          const validLang = lang && hljs.getLanguage(lang) ? lang : undefined;
          let highlighted = "";

          try {
            highlighted = validLang
              ? hljs.highlight(rawCode, { language: validLang }).value
              : hljs.highlightAuto(rawCode).value;
          } catch {
            highlighted = rawCode
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
          }

          const displayLang = validLang || lang || "code";
          const encodedCode = encodeURIComponent(rawCode);

          return `<div class="siri-code-container" data-code="${encodedCode}">
  <div class="siri-code-header">
    <span class="siri-code-lang">${displayLang}</span>
    <button class="siri-code-copy-btn" type="button" aria-label="Copy code">
      <svg class="siri-copy-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span class="siri-copy-label">Copy</span>
    </button>
  </div>
  <pre><code class="hljs ${validLang ? `language-${validLang}` : ""}">${highlighted}</code></pre>
</div>`;
        },
        link({ href, title, text }: { href: string; title?: string | null; text: string }) {
          const safeHref = href || "#";
          const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
          return `<a href="${safeHref}" class="siri-markdown-link" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}<svg class="siri-link-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
        },
      },
    });

    return m;
  }, []);

  const renderedHtml = useMemo(() => {
    if (!content) return "";
    try {
      const parsed = markedInstance.parse(content);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return content;
    }
  }, [content, markedInstance]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // Handle code copy button click
    const copyBtn = target.closest(".siri-code-copy-btn");
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const container = copyBtn.closest(".siri-code-container");
      if (container) {
        const rawCode = container.getAttribute("data-code");
        if (rawCode) {
          const decoded = decodeURIComponent(rawCode);
          navigator.clipboard.writeText(decoded).then(() => {
            const labelSpan = copyBtn.querySelector(".siri-copy-label");
            if (labelSpan) {
              const original = labelSpan.textContent;
              labelSpan.textContent = "Copied! ✓";
              copyBtn.classList.add("copied");
              setTimeout(() => {
                labelSpan.textContent = original;
                copyBtn.classList.remove("copied");
              }, 1800);
            }
          }).catch(() => {});
        }
      }
      return;
    }

    // Handle link clicks with external browser opener
    const linkEl = target.closest("a.siri-markdown-link") as HTMLAnchorElement | null;
    if (linkEl && linkEl.href) {
      e.preventDefault();
      e.stopPropagation();
      try {
        openUrl(linkEl.href).catch(() => window.open(linkEl.href, "_blank"));
      } catch {
        window.open(linkEl.href, "_blank");
      }
    }
  }, []);

  return (
    <div
      className={`siri-markdown-root ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
      onClick={handleClick}
    />
  );
};
