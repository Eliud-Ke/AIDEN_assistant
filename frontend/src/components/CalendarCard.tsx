import React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface CalendarEventItem {
  id?: string;
  summary: string;
  time: string;
  date?: string;
  weekday?: string;
  dayNumber?: string;
  month?: string;
  isAllDay?: boolean;
  location?: string;
  meetLink?: string;
  htmlLink?: string;
  status?: string;
  duration?: string;
}

export interface ConflictItem {
  summary: string;
  time: string;
  location?: string;
}

export interface CalendarCardProps {
  mode?: "agenda" | "created" | "search" | "updated" | "deleted" | "availability";
  label?: string;
  count?: number;
  events?: CalendarEventItem[];
  event?: CalendarEventItem;
  query?: string;
  oldTime?: string;
  newTime?: string;
  timeWindow?: string;
  isFree?: boolean;
  conflicts?: ConflictItem[];
  suggestedSlot?: string;
  onOpenEvent?: (event: CalendarEventItem) => void;
  onAction?: (action: string, payload?: any) => void;
}

interface GroupedDay {
  weekday: string;
  dayNumber: string;
  dateKey: string;
  events: CalendarEventItem[];
}

export const CalendarCard: React.FC<CalendarCardProps> = ({
  mode = "agenda",
  label = "Today",
  count,
  events = [],
  event,
  query,
  oldTime,
  newTime,
  timeWindow,
  isFree,
  conflicts = [],
  suggestedSlot,
  onOpenEvent,
  onAction,
}) => {
  const handleOpenLink = (url?: string) => {
    const targetUrl = url || "https://calendar.google.com";
    try {
      openUrl(targetUrl).catch(() => window.open(targetUrl, "_blank"));
    } catch {
      window.open(targetUrl, "_blank");
    }
  };

  const handleEventClick = (ev: CalendarEventItem) => {
    if (onOpenEvent) {
      onOpenEvent(ev);
      return;
    }
    handleOpenLink(ev.htmlLink || ev.meetLink || "https://calendar.google.com");
  };

  // Group events by day for multi-day agenda rendering
  const groupedDays: GroupedDay[] = React.useMemo(() => {
    if (!events || events.length === 0) return [];

    const map = new Map<string, GroupedDay>();

    for (const ev of events) {
      const weekday = (ev.weekday || "TODAY").toUpperCase();
      const dayNumber = ev.dayNumber || "";
      const dateKey = `${weekday}_${dayNumber}_${ev.date || ""}`;

      if (!map.has(dateKey)) {
        map.set(dateKey, {
          weekday,
          dayNumber,
          dateKey,
          events: [],
        });
      }
      map.get(dateKey)!.events.push(ev);
    }

    return Array.from(map.values());
  }, [events]);

  // ========================================================
  // MODE 1: CREATE EVENT CONFIRMATION CARD
  // ========================================================
  if (mode === "created") {
    const targetEvent = event || (events && events[0]) || {
      summary: "Scheduled Event",
      time: "Scheduled Time",
      date: label || "Upcoming",
    };
    const hasMeet = Boolean(targetEvent.meetLink);

    return (
      <div className="siri-calendar-card siri-calendar-created">
        <div className="card-top-status">
          <div className="status-left">
            <span className="status-pill success">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Scheduled
            </span>
          </div>
          <span className="card-top-note">Added to Primary</span>
        </div>

        <div className="event-hero-card">
          <div className="event-hero-title">{targetEvent.summary || "(No Title)"}</div>

          <div className="event-details-grid">
            <div className="detail-item-row">
              <div className="detail-icon-wrap">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <span>
                {targetEvent.date ? `${targetEvent.date} • ` : ""}
                {targetEvent.time || (targetEvent.isAllDay ? "All day" : "Scheduled")}
                {targetEvent.duration ? ` (${targetEvent.duration})` : ""}
              </span>
            </div>

            {targetEvent.location && (
              <div className="detail-item-row">
                <div className="detail-icon-wrap">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </div>
                <span>{targetEvent.location}</span>
              </div>
            )}

            {hasMeet && (
              <div className="detail-item-row">
                <div className="detail-icon-wrap meet">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17 10.5V7C17 5.9 16.1 5 15 5H4C2.9 5 2 5.9 2 7V17C2 18.1 2.9 19 4 19H15C16.1 19 17 18.1 17 17V13.5L21 17.5V6.5L17 10.5Z" />
                  </svg>
                </div>
                <button
                  type="button"
                  className="meet-link-btn"
                  onClick={() => handleOpenLink(targetEvent.meetLink)}
                  title="Open Google Meet"
                >
                  <span>Google Meet Video Link</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          <div className="card-action-buttons">
            <button
              type="button"
              className="action-chip-btn secondary"
              onClick={() => onAction && onAction("reschedule", targetEvent)}
              title="Reschedule this event"
            >
              Reschedule
            </button>
            <button
              type="button"
              className="action-chip-btn primary"
              onClick={() => handleOpenLink(targetEvent.htmlLink)}
              title="Open event in Google Calendar"
            >
              Open in Calendar
            </button>
          </div>
        </div>

        <div className="cal-bottom-bar">
          <span>Google Calendar</span>
          <button
            type="button"
            className="cal-open-link"
            onClick={() => handleOpenLink(targetEvent.htmlLink)}
          >
            <span>View</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ========================================================
  // MODE 2: SEARCH RESULTS CARD
  // ========================================================
  if (mode === "search") {
    const displayCount = count || events.length;

    return (
      <div className="siri-calendar-card siri-calendar-search">
        <div className="cal-search-meta">
          <div className="cal-query-pill">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>{query ? `"${query}"` : "Search"}</span>
          </div>
          <span className="cal-results-count">
            {displayCount} event{displayCount === 1 ? "" : "s"} found
          </span>
        </div>

        {events && events.length > 0 ? (
          <div className="cal-search-stack">
            {events.map((ev, i) => {
              const monthLabel = ev.month || (ev.date ? ev.date.split(" ")[1]?.slice(0, 3).toUpperCase() : "CAL");
              const dayNum = ev.dayNumber || (ev.date ? ev.date.match(/\d+/)?.[0] : "•");

              return (
                <div
                  key={ev.id || i}
                  className="cal-search-tile"
                  onClick={() => handleEventClick(ev)}
                  title="Click to view event in Google Calendar"
                >
                  <div className="search-date-badge">
                    <span className="search-date-month">{monthLabel}</span>
                    <span className="search-date-day">{dayNum}</span>
                  </div>

                  <div className="search-tile-info">
                    <span className="search-tile-title">{ev.summary || "(No Title)"}</span>
                    <span className="search-tile-time">
                      {ev.time || (ev.isAllDay ? "All day" : "")}
                      {ev.location ? ` • ${ev.location}` : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="cal-empty-state">
            <span>No events found matching {query ? `"${query}"` : "your search"}.</span>
          </div>
        )}

        <div className="cal-bottom-bar">
          <span>Search in Primary Calendar</span>
          <button
            type="button"
            className="cal-open-link"
            onClick={() => handleOpenLink("https://calendar.google.com")}
          >
            <span>View All</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ========================================================
  // MODE 3: UPDATE / RESCHEDULE CARD
  // ========================================================
  if (mode === "updated") {
    const targetEvent = event || (events && events[0]) || {
      summary: "Updated Event",
      time: newTime || "Updated Time",
    };

    return (
      <div className="siri-calendar-card siri-calendar-updated">
        <div className="card-top-status">
          <div className="status-left">
            <span className="status-pill updated">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              Rescheduled
            </span>
          </div>
          <span className="card-top-note">Changes Saved</span>
        </div>

        <div className="reschedule-comparison-card">
          <div className="reschedule-title">{targetEvent.summary || "(No Title)"}</div>

          <div className="diff-boxes-row">
            {oldTime && (
              <>
                <div className="diff-box old">
                  <span className="diff-label">Previous</span>
                  <span className="diff-val">{oldTime}</span>
                </div>
                <div className="diff-arrow">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </div>
              </>
            )}
            <div className="diff-box new">
              <span className="diff-label">Updated</span>
              <span className="diff-val">{newTime || targetEvent.time}</span>
            </div>
          </div>

          {targetEvent.date && (
            <div className="detail-item-row" style={{ marginTop: 2 }}>
              <div className="detail-icon-wrap">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <span>{targetEvent.date}</span>
            </div>
          )}
        </div>

        <div className="cal-bottom-bar">
          <span>Google Calendar Sync</span>
          <button
            type="button"
            className="cal-open-link"
            onClick={() => handleOpenLink(targetEvent.htmlLink)}
          >
            <span>View</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ========================================================
  // MODE 4: DELETE / CANCELLATION RECEIPT CARD
  // ========================================================
  if (mode === "deleted") {
    const title = event?.summary || label || "Event";
    const cancelledTime = event?.time || oldTime || "";

    return (
      <div className="siri-calendar-card siri-calendar-deleted">
        <div className="card-top-status">
          <div className="status-left">
            <span className="status-pill deleted">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Cancelled
            </span>
          </div>
          <span className="card-top-note">Removed from Schedule</span>
        </div>

        <div className="delete-receipt-card">
          <div className="delete-event-title">{title}</div>
          {cancelledTime && (
            <div className="delete-meta-row">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Was scheduled for {cancelledTime}</span>
            </div>
          )}
        </div>

        <div className="cal-bottom-bar">
          <span>Event moved to Trash</span>
          <button
            type="button"
            className="cal-open-link"
            style={{ color: "#d93025" }}
            onClick={() => handleOpenLink("https://calendar.google.com/calendar/u/0/r/trash")}
          >
            <span>View Trash</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ========================================================
  // MODE 5: AVAILABILITY & CONFLICT CHECKER CARD
  // ========================================================
  if (mode === "availability") {
    const hasConflicts = conflicts && conflicts.length > 0;
    const isFreeSlot = typeof isFree === "boolean" ? isFree : !hasConflicts;

    return (
      <div className="siri-calendar-card siri-calendar-availability">
        <div className="card-top-status">
          <div className="status-left">
            {isFreeSlot ? (
              <span className="status-pill available">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Available
              </span>
            ) : (
              <span className="status-pill conflict">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                {conflicts.length} Conflict{conflicts.length === 1 ? "" : "s"} Found
              </span>
            )}
          </div>
          {timeWindow && <span className="card-top-note">{timeWindow}</span>}
        </div>

        <div className={`availability-card ${isFreeSlot ? "free" : "conflict"}`}>
          {timeWindow && (
            <span className="avail-window-label">Requested Time Window: {timeWindow}</span>
          )}

          {isFreeSlot ? (
            <div className="avail-slot-pill">
              <span>Completely free • No conflicts scheduled</span>
              <button
                type="button"
                className="action-chip-btn primary"
                style={{ flex: 0, padding: "5px 12px", fontSize: 11.5 }}
                onClick={() => onAction && onAction("schedule", timeWindow)}
                title="Schedule an event in this slot"
              >
                Schedule Event
              </button>
            </div>
          ) : (
            <>
              {conflicts.map((c, i) => (
                <div key={i} className="conflict-tile">
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span className="conflict-title">{c.summary || "Busy"}</span>
                    <span className="conflict-time">{c.time}</span>
                  </div>
                  <span className="conflict-chip">Busy</span>
                </div>
              ))}

              {suggestedSlot && (
                <div className="avail-slot-pill">
                  <span>{suggestedSlot}</span>
                  <button
                    type="button"
                    className="action-chip-btn primary"
                    style={{ flex: 0, padding: "4px 10px", fontSize: 11 }}
                    onClick={() => onAction && onAction("book_suggested", suggestedSlot)}
                    title="Book suggested slot"
                  >
                    Book Slot
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="cal-bottom-bar">
          <span>Free/Busy Check</span>
          <button
            type="button"
            className="cal-open-link"
            onClick={() => handleOpenLink("https://calendar.google.com")}
          >
            <span>Calendar</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ========================================================
  // MODE 6: AGENDA CARD (OPTION B MINIMALIST WIDGET)
  // ========================================================
  return (
    <div className="siri-calendar-card siri-calendar-minimal">
      {/* Scrollable Container for Days and Event Tiles */}
      <div className="cal-days-container">
        {groupedDays.length > 0 ? (
          groupedDays.map((dayGroup, dayIdx) => (
            <React.Fragment key={dayGroup.dateKey || dayIdx}>
              {dayIdx > 0 && <div className="cal-day-divider" />}

              <div className="cal-day-block">
                {/* Day Header: Weekday + Day Number on Left, Indicators on Right */}
                <div className="cal-day-header">
                  <div className="cal-day-date-group">
                    <span className="cal-day-name">{dayGroup.weekday}</span>
                    <span className="cal-day-number">{dayGroup.dayNumber}</span>
                  </div>

                  {/* Indicator Pills matching number of events for the day */}
                  <div
                    className="cal-day-indicators"
                    title={`${dayGroup.events.length} event${dayGroup.events.length === 1 ? "" : "s"}`}
                  >
                    {dayGroup.events.map((ev, i) => (
                      <div
                        key={ev.id || i}
                        className={`cal-indicator-pill ${ev.meetLink ? "meet" : ""}`}
                      />
                    ))}
                  </div>
                </div>

                {/* Events Stack */}
                <div className="cal-events-stack">
                  {dayGroup.events.map((item, itemIdx) => {
                    const isMeet = Boolean(item.meetLink);

                    return (
                      <div
                        key={item.id || itemIdx}
                        className="cal-event-tile"
                        onClick={() => handleEventClick(item)}
                        title="Click to view event details"
                      >
                        {/* Left Vertical Accent Bar */}
                        <div className={`cal-accent-bar ${isMeet ? "meet" : ""}`} />

                        {/* Event Content */}
                        <div className="cal-event-content">
                          <span className="cal-event-title">{item.summary || "(No Title)"}</span>

                          <div className="cal-event-time-row">
                            <span>{item.time || (item.isAllDay ? "All day" : "Scheduled")}</span>

                            {/* Google Meet Badge */}
                            {isMeet && (
                              <span
                                className="cal-meet-badge"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenLink(item.meetLink);
                                }}
                                title="Join Google Meet"
                              >
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M17 10.5V7C17 5.9 16.1 5 15 5H4C2.9 5 2 5.9 2 7V17C2 18.1 2.9 19 4 19H15C16.1 19 17 18.1 17 17V13.5L21 17.5V6.5L17 10.5Z" />
                                </svg>
                                Meet
                              </span>
                            )}

                            {/* Location Badge */}
                            {item.location && (
                              <span className="cal-loc-badge" title={item.location}>
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                                  <circle cx="12" cy="10" r="3" />
                                </svg>
                                {item.location}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </React.Fragment>
          ))
        ) : (
          <div className="cal-empty-state">
            <span>No events scheduled for {label}.</span>
          </div>
        )}
      </div>

      {/* Bottom Minimal Footer Bar */}
      <div className="cal-bottom-bar">
        <span>Google Calendar</span>
        <button
          type="button"
          className="cal-open-link"
          onClick={() => handleOpenLink("https://calendar.google.com")}
          title="Open Google Calendar"
        >
          <span>Open</span>
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
  );
};
