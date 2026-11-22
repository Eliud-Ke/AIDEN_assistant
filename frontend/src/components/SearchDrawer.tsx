import React, { useEffect, useRef } from "react";
import "./SearchDrawer.css";

export interface SearchItem {
  id: string;
  name: string;
  subtitle: string;
  kind: string;
  launchKind: string;
  target: string;
  iconKey: string;
  iconDataUrl?: string | null;
  aliases?: string[];
}

export interface ConjoinedSearchTrayProps {
  open: boolean;
  query: string;
  mode: "recents" | "search";
  recents: SearchItem[];
  apps: SearchItem[];
  bookmarks: SearchItem[];
  files: SearchItem[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onLaunchItem: (item: SearchItem, revealInExplorer: boolean, runAsAdmin: boolean) => void;
}

function getFallbackLabel(item: SearchItem): string {
  if (item.kind === "File" || item.kind === "Program") {
    const dot = item.name.lastIndexOf(".");
    if (dot > 0 && dot < item.name.length - 1) {
      return item.name.slice(dot + 1, dot + 5).toUpperCase();
    }
  }
  return item.name.slice(0, 2).toUpperCase();
}

function renderHighlightedTitle(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q || q.includes(" ")) return text;
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const idx = lowerText.indexOf(lowerQ);
  if (idx !== -1) {
    return (
      <>
        {text.slice(0, idx)}
        <mark>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  }

  // Fuzzy/typo fallback: highlight the longest shared prefix (>= 2 chars) on any matching word
  let bestStart = -1;
  let bestLen = 0;
  const wordRe = /[A-Za-z0-9]+/g;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(text)) !== null) {
    const wordLower = match[0].toLowerCase();
    const maxK = Math.min(wordLower.length, lowerQ.length);
    let k = 0;
    while (k < maxK && wordLower[k] === lowerQ[k]) {
      k++;
    }
    if (k >= 2 && k > bestLen) {
      bestStart = match.index;
      bestLen = k;
    }
  }

  if (bestStart !== -1 && bestLen >= 2) {
    return (
      <>
        {text.slice(0, bestStart)}
        <mark>{text.slice(bestStart, bestStart + bestLen)}</mark>
        {text.slice(bestStart + bestLen)}
      </>
    );
  }

  return text;
}

export const ConjoinedSearchTray: React.FC<ConjoinedSearchTrayProps> = ({
  open,
  query,
  mode,
  recents,
  apps,
  bookmarks,
  files,
  selectedIndex,
  onSelectIndex,
  onLaunchItem,
}) => {
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Keep keyboard-selected row smoothly visible inside the scroll viewport
  useEffect(() => {
    if (!open || selectedIndex < 0) return;
    const el = rowRefs.current.get(selectedIndex);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [open, selectedIndex, query, mode]);

  const handleRowMouseDown = (e: React.MouseEvent, item: SearchItem) => {
    e.preventDefault();
    e.stopPropagation();
    const reveal = e.ctrlKey || e.metaKey;
    const runAsAdmin = e.shiftKey && !reveal;
    onLaunchItem(item, reveal, runAsAdmin);
  };

  let runningIdx = 0;

  const renderRow = (item: SearchItem, q: string) => {
    const idx = runningIdx++;
    const isSel = idx === selectedIndex;
    const isBookmark = item.kind === "Bookmark";
    const isFolder = item.kind === "Folder";
    const kindClass =
      item.kind === "System"
        ? "kind-system"
        : isBookmark
        ? "kind-bookmark"
        : isFolder
        ? "kind-folder"
        : item.kind === "File"
        ? "kind-file"
        : "kind-app";

    return (
      <div
        key={`${item.id}-${idx}`}
        ref={(node) => {
          if (node) rowRefs.current.set(idx, node);
          else rowRefs.current.delete(idx);
        }}
        className={`sd-row ${isSel ? "selected" : ""}`}
        onMouseEnter={() => {
          if (idx !== selectedIndex) onSelectIndex(idx);
        }}
        onMouseDown={(e) => handleRowMouseDown(e, item)}
      >
        <div
          className={`sd-icon-wrap ${item.iconDataUrl ? "has-native-img" : ""} ${
            isBookmark ? "is-bookmark" : ""
          }`}
        >
          {item.iconDataUrl ? (
            <img
              src={item.iconDataUrl}
              alt=""
              className={`sd-icon-img ${isBookmark ? "is-bookmark-favicon" : ""}`}
              draggable={false}
            />
          ) : isBookmark ? (
            <div className="sd-icon-fallback kind-bookmark" aria-hidden="true">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9.5" />
                <line x1="2.5" y1="12" x2="21.5" y2="12" />
                <path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19z" />
              </svg>
            </div>
          ) : isFolder ? (
            <div className="sd-icon-fallback kind-folder" aria-hidden="true">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5V6.5z" />
              </svg>
            </div>
          ) : (
            <div className={`sd-icon-fallback ${kindClass}`}>{getFallbackLabel(item)}</div>
          )}
        </div>
        <div className="sd-row-main">
          <div className="sd-row-title">{renderHighlightedTitle(item.name, q)}</div>
        </div>
      </div>
    );
  };

  const isRecentsMode = mode === "recents";

  return (
    <div className={`conjoined-search-tray ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="search-drawer-scroll">
        {isRecentsMode ? (
          recents.length === 0 ? (
            <div className="sd-empty-state">
              <div className="sd-empty-icon">
                <svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="20" y1="20" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <div className="sd-empty-title">Your recent searches will appear here</div>
              <div className="sd-empty-hint">
                Type 4+ characters to search apps, bookmarks &amp; files automatically, or press ↓
                anytime for short queries like <strong>svc</strong>.
              </div>
            </div>
          ) : (
            recents.map((item) => renderRow(item, ""))
          )
        ) : (
          <>
            {apps.map((item) => renderRow(item, query))}
            {apps.length > 0 && (bookmarks.length > 0 || files.length > 0) && (
              <div className="sd-group-divider" />
            )}
            {bookmarks.map((item) => renderRow(item, query))}
            {bookmarks.length > 0 && files.length > 0 && <div className="sd-group-divider" />}
            {files.map((item) => renderRow(item, query))}
          </>
        )}
      </div>
    </div>
  );
};
