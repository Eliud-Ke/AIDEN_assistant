import React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface GmailEmailItem {
  id: string;
  sender: string;
  email?: string;
  time: string;
  subject: string;
  snippet: string;
  unread?: boolean;
}

export interface GmailCardProps {
  count?: number;
  emails?: GmailEmailItem[];
  subtitle?: string;
  mode?: "unread" | "search" | "read";
  query?: string;

  // Single email read mode fields
  id?: string;
  sender?: string;
  email?: string;
  date?: string;
  subject?: string;
  summary?: string;
  avatar?: string;

  onSelectEmail?: (email: GmailEmailItem) => void;
  onAction?: (action: "reply" | "archive" | "mark_unread", id?: string, sender?: string) => void;
}

export const GmailCard: React.FC<GmailCardProps> = ({
  count = 0,
  emails = [],
  subtitle,
  mode = "unread",
  query,
  id,
  sender,
  email,
  date,
  subject,
  summary,
  avatar,
  onSelectEmail,
  onAction,
}) => {
  // ========================================================
  // MODE: READ EMAIL (Single Email Card with Human Summary)
  // ========================================================
  if (mode === "read") {
    const cleanSender = sender || "Sender";
    const cleanEmail = email || "";
    const cleanDate = date || "";
    const cleanSubject = subject || "(No Subject)";
    const cleanSummary = summary || "(No summary available)";
    const initials =
      avatar ||
      cleanSender
        .trim()
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase() ||
      "GM";

    const handleOpenInGmail = () => {
      const url = id
        ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}`
        : "https://mail.google.com/mail/u/0/#inbox";
      try {
        openUrl(url).catch(() => window.open(url, "_blank"));
      } catch {
        window.open(url, "_blank");
      }
    };

    return (
      <div className="siri-gmail-card siri-gmail-read-card">
        {/* Top Header */}
        <div className="gmail-card-header">
          <div className="gmail-brand-group">
            <div className="gmail-logo-wrapper">
              <svg
                className="gmail-logo-svg"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M22 6.5C22 5.12 20.88 4 19.5 4H18V13.5L22 10.5V6.5Z" fill="#EA4335" />
                <path d="M2 6.5C2 5.12 3.12 4 4.5 4H6V13.5L2 10.5V6.5Z" fill="#4285F4" />
                <path d="M6 13.5V20H4.5C3.12 20 2 18.88 2 17.5V10.5L6 13.5Z" fill="#34A853" />
                <path d="M18 13.5V20H19.5C20.88 20 22 18.88 22 17.5V10.5L18 13.5Z" fill="#FBBC04" />
                <path d="M6 4V13.5L12 18L18 13.5V4L12 8.5L6 4Z" fill="#EA4335" />
              </svg>
            </div>
            <div className="gmail-title-group">
              <span className="gmail-card-title">Gmail</span>
              <span className="gmail-card-subtitle">{subtitle || "Email details & summary"}</span>
            </div>
          </div>

          <div className="read-top-actions">
            <button
              type="button"
              className="open-web-btn"
              onClick={handleOpenInGmail}
              title="Open email in browser"
            >
              <span>Open in Gmail</span>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          </div>
        </div>

        {/* Sender & Subject Box */}
        <div className="email-sender-card">
          <div className="sender-profile-row">
            <div className="sender-details-group">
              <div className="sender-avatar">{initials}</div>
              <div className="sender-text-col">
                <div className="sender-name-line">
                  <span>{cleanSender}</span>
                </div>
                {cleanEmail && <span className="sender-email-address">{cleanEmail}</span>}
              </div>
            </div>
            {cleanDate && <div className="date-badge">{cleanDate}</div>}
          </div>

          <div className="email-subject-line">{cleanSubject}</div>
        </div>

        {/* Summary Box with Floating Action Buttons */}
        <div className="email-summary-box">
          <div className="summary-header">
            <span className="summary-label">Summary</span>

            <div className="summary-floating-actions">
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => onAction && onAction("mark_unread", id, cleanSender)}
                title="Mark this email as unread"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                <span>Mark Unread</span>
              </button>

              <button
                type="button"
                className="action-btn secondary"
                onClick={() => onAction && onAction("archive", id, cleanSender)}
                title="Archive this email"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
                <span>Archive</span>
              </button>

              <button
                type="button"
                className="action-btn primary"
                onClick={() => onAction && onAction("reply", id, cleanSender)}
                title="Reply to this email"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 17 4 12 9 7" />
                  <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                </svg>
                <span>Reply</span>
              </button>
            </div>
          </div>

          <div className="summary-prose">{cleanSummary}</div>
        </div>
      </div>
    );
  }

  // ========================================================
  // MODE: LIST UNREAD / SEARCH RESULTS
  // ========================================================
  const displayCount = count || emails.length;
  const isSearchMode = mode === "search" || Boolean(query);

  const defaultSubtitle = isSearchMode
    ? query
      ? `${displayCount} result${displayCount === 1 ? "" : "s"} matching "${query}"`
      : `${displayCount} result${displayCount === 1 ? "" : "s"} found`
    : displayCount === 0
    ? "No unread emails in your inbox"
    : displayCount === 1
    ? "You have 1 unread email"
    : `You have ${displayCount} unread emails`;

  const subtitleText = subtitle || defaultSubtitle;

  const handleEmailClick = (emailItem: GmailEmailItem) => {
    if (onSelectEmail) {
      onSelectEmail(emailItem);
      return;
    }

    const url = "https://mail.google.com/mail/u/0/#inbox";
    try {
      openUrl(url).catch(() => window.open(url, "_blank"));
    } catch {
      window.open(url, "_blank");
    }
  };

  return (
    <div className="siri-gmail-card">
      {/* Top Header */}
      <div className="gmail-card-header">
        <div className="gmail-brand-group">
          <div className="gmail-logo-wrapper">
            <svg
              className="gmail-logo-svg"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M22 6.5C22 5.12 20.88 4 19.5 4H18V13.5L22 10.5V6.5Z" fill="#EA4335" />
              <path d="M2 6.5C2 5.12 3.12 4 4.5 4H6V13.5L2 10.5V6.5Z" fill="#4285F4" />
              <path d="M6 13.5V20H4.5C3.12 20 2 18.88 2 17.5V10.5L6 13.5Z" fill="#34A853" />
              <path d="M18 13.5V20H19.5C20.88 20 22 18.88 22 17.5V10.5L18 13.5Z" fill="#FBBC04" />
              <path d="M6 4V13.5L12 18L18 13.5V4L12 8.5L6 4Z" fill="#EA4335" />
            </svg>

            {/* Search Lens Badge Overlay in Search Mode */}
            {isSearchMode && (
              <div className="gmail-search-lens-badge" title="Search Results">
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
            )}
          </div>
          <div className="gmail-title-group">
            <span className="gmail-card-title">Gmail</span>
            <span className="gmail-card-subtitle">{subtitleText}</span>
          </div>
        </div>

        {displayCount > 0 &&
          (isSearchMode ? (
            <div className="gmail-search-badge">
              <svg
                className="gmail-search-icon"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span>{displayCount} found</span>
            </div>
          ) : (
            <div className="gmail-unread-badge">
              <span className="gmail-badge-dot"></span>
              <span>{displayCount} new</span>
            </div>
          ))}
      </div>

      {/* Scrollable Individual Email Cards Viewport */}
      {emails && emails.length > 0 && (
        <div className="gmail-scroll-viewport">
          {emails.map((item, idx) => (
            <div
              key={item.id || idx}
              className="gmail-email-item"
              onClick={() => handleEmailClick(item)}
              title="Click to read email"
            >
              {/* Item Top Row: Sender + Timestamp + Unread Dot (if unread) */}
              <div className="email-item-header">
                <span className="email-sender">{item.sender || "Unknown Sender"}</span>
                <div className="email-meta-group">
                  {item.time && <span className="email-timestamp">{item.time}</span>}
                  {item.unread && <span className="email-unread-indicator" title="Unread"></span>}
                </div>
              </div>

              {/* Subject */}
              <div className="email-subject">{item.subject || "(No Subject)"}</div>

              {/* 2-Line Body Snippet */}
              <div className="email-snippet">
                {item.snippet || "(No content preview)"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
