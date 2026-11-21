import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
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

export interface SearchDrawerSyncPayload {
  open: boolean;
  darkMode?: boolean;
  query?: string;
  mode?: "recents" | "search";
  recents?: SearchItem[];
  apps?: SearchItem[];
  files?: SearchItem[];
  selectedIndex?: number;
  everythingAvailable?: boolean;
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
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export const SearchDrawerWindow: React.FC = () => {
  const [state, setState] = useState<SearchDrawerSyncPayload>({
    open: false,
    darkMode: true,
    query: "",
    mode: "recents",
    recents: [],
    apps: [],
    files: [],
    selectedIndex: -1,
    everythingAvailable: false,
  });

  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    let disposed = false;
    let unlistenSync: (() => void) | undefined;

    const setup = async () => {
      try {
        const unlisten = await listen<SearchDrawerSyncPayload>("search-drawer-sync", (event) => {
          const payload = event.payload;
          if (!payload) return;
          setState((prev) => ({
            ...prev,
            ...payload,
          }));
        });
        if (disposed) {
          unlisten();
        } else {
          unlistenSync = unlisten;
          // Hydrate latest drawer state in case the first sync fired while mounting
          try {
            const initial = await invoke<SearchDrawerSyncPayload>("get_search_drawer_state");
            if (!disposed && initial) {
              setState((prev) => ({ ...prev, ...initial }));
            }
          } catch {
            // Ignore
          }
        }
      } catch {
        // Fallback outside Tauri
      }
    };

    setup();
    return () => {
      disposed = true;
      if (unlistenSync) unlistenSync();
    };
  }, []);

  const selectedIndex = state.selectedIndex ?? -1;

  // Keep keyboard-selected row smoothly visible inside the scroll viewport
  useEffect(() => {
    if (selectedIndex < 0) return;
    const el = rowRefs.current.get(selectedIndex);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex, state.query, state.mode]);

  const query = state.query || "";
  const isRecentsMode = state.mode === "recents";
  const recents = state.recents || [];
  const apps = state.apps || [];
  const files = state.files || [];
  const isDarkMode = state.darkMode !== false;

  const flatItems: SearchItem[] = isRecentsMode ? recents : [...apps, ...files];
  const selectedItem = selectedIndex >= 0 ? flatItems[selectedIndex] : undefined;

  const handleRowClick = (e: React.MouseEvent, item: SearchItem) => {
    e.preventDefault();
    const reveal = e.ctrlKey || e.metaKey;
    invoke("launch_search_item", { item, revealInExplorer: reveal }).catch(() => {});
  };

  const handleRowHover = (idx: number) => {
    if (idx !== selectedIndex) {
      setState((prev) => ({ ...prev, selectedIndex: idx }));
      invoke("notify_search_drawer_hover", { index: idx }).catch(() => {});
    }
  };

  let runningIdx = 0;

  const renderRow = (item: SearchItem, q: string) => {
    const idx = runningIdx++;
    const isSel = idx === selectedIndex;
    const enterWord = item.kind === "File" ? "Open" : "Launch";
    const kindClass =
      item.kind === "System"
        ? "kind-system"
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
        onMouseEnter={() => handleRowHover(idx)}
        onMouseDown={(e) => handleRowClick(e, item)}
      >
        <div className={`sd-icon-wrap ${item.iconDataUrl ? "has-native-img" : ""}`}>
          {item.iconDataUrl ? (
            <img src={item.iconDataUrl} alt="" className="sd-icon-img" draggable={false} />
          ) : (
            <div className={`sd-icon-fallback ${kindClass}`}>{getFallbackLabel(item)}</div>
          )}
        </div>
        <div className="sd-row-main">
          <div className="sd-row-title">{renderHighlightedTitle(item.name, q)}</div>
          <div className="sd-row-sub">{item.subtitle}</div>
        </div>
        <div className="sd-row-right">
          <span className="sd-kind-tag">{item.kind}</span>
          <span className="sd-enter-badge">↵ {enterWord}</span>
        </div>
      </div>
    );
  };

  const sourceLabel = isRecentsMode
    ? recents.length === 0
      ? "Recent · Empty"
      : "Recent Launches"
    : files.length > 0
    ? "Apps · Everything CLI"
    : state.everythingAvailable
    ? "Apps · Unified Index"
    : "Apps";

  const footerEnterText = selectedItem
    ? selectedItem.kind === "File"
      ? "Open File"
      : "Open App"
    : query.trim().length > 0
    ? "Ask AIDEN"
    : "Open";

  return (
    <div
      className={`search-drawer-window ${state.open ? "open" : ""} ${
        isDarkMode ? "dark-mode" : "light-mode"
      }`}
    >
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
                Type 4+ characters to search apps &amp; files automatically, or press ↓ anytime for
                short queries like <strong>svc</strong>.
              </div>
            </div>
          ) : (
            <>
              <div className="sd-section-header">
                <span>Recent Searches</span>
                <span className="sd-section-count">{recents.length}</span>
              </div>
              {recents.map((item) => renderRow(item, ""))}
            </>
          )
        ) : (
          <>
            {apps.length > 0 && (
              <>
                <div className="sd-section-header">
                  <span>Apps</span>
                  <span className="sd-section-count">{apps.length}</span>
                </div>
                {apps.map((item) => renderRow(item, query))}
              </>
            )}
            {files.length > 0 && (
              <>
                <div className="sd-section-header">
                  <span>Files</span>
                  <span className="sd-section-count">{files.length}</span>
                </div>
                {files.map((item) => renderRow(item, query))}
              </>
            )}
          </>
        )}
      </div>

      <div className="sd-footer">
        <div className="sd-footer-hints">
          <span className="sd-hint">
            <span className="sd-keycap">↑</span>
            <span className="sd-keycap">↓</span> Navigate
          </span>
          <span className="sd-hint">
            <span className="sd-keycap">↵</span> {footerEnterText}
          </span>
          {selectedItem && (selectedItem.kind === "File" || selectedItem.kind === "Program") && (
            <span className="sd-hint">
              <span className="sd-keycap">Ctrl+↵</span> Folder
            </span>
          )}
          <span className="sd-hint">
            <span className="sd-keycap">Esc</span> Close
          </span>
        </div>
        <span>{sourceLabel}</span>
      </div>
    </div>
  );
};
