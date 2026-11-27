import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LocationCard } from "./LocationCard";
import { GmailCard, GmailEmailItem } from "./GmailCard";
import { CalendarCard, CalendarEventItem } from "./CalendarCard";
import { SystemSlider } from "./SystemSlider";
import { WeatherCard, WeatherCardData } from "./WeatherCard";
import { SpotifyArtistCard, SpotifyArtistCardData } from "./SpotifyArtistCard";
import { SpotifyTracksCard, SpotifyTracksCardData, SpotifyTrackItem } from "./SpotifyTracksCard";
import { SpotifyAlbumsCard, SpotifyAlbumsCardData, SpotifyAlbumItem } from "./SpotifyAlbumsCard";
import { SpotifyPlaylistsCard, SpotifyPlaylistsCardData, SpotifyPlaylistItem } from "./SpotifyPlaylistsCard";
import { SpotifyLibraryPlaylistsCard, SpotifyLibraryPlaylistsCardData } from "./SpotifyLibraryPlaylistsCard";
import { MarkdownContent } from "./MarkdownContent";
import { PipSquareEyes } from "./PipSquareEyes";
import { ConjoinedSearchTray, SearchItem } from "./SearchDrawer";
import { AntigravityWorkCard, AgyWorkJobState } from "./AntigravityWorkCard";
import { FileAgentCard, FileAgentJobState, FileAgentTreeEdge, FileAgentTreeNode } from "./FileAgentCard";
import { A2UISurface, A2UISurfacePayload, A2UIActionEvent } from "./A2UISurface";
import { YouTubeCard, YouTubeCardData, YouTubeVideoItem, YouTubeLoadingSkeleton } from "./YouTubeCard";
import {
  AIDEN_BROWSER_OPEN_EVENT,
  AidenBrowserOpenDetail,
  openInAidenBrowser,
} from "../utils/aidenBrowser";
import "./ChatPill.css";

interface UnifiedSearchResponse {
  query: string;
  mode: "recents" | "search";
  recents: SearchItem[];
  apps: SearchItem[];
  bookmarks: SearchItem[];
  files: SearchItem[];
  everythingAvailable: boolean;
}

const SEARCH_AUTO_THRESHOLD = 4;

function computeSearchDrawerHeight(res: UnifiedSearchResponse): number {
  if (res.mode === "recents") {
    if (res.recents.length === 0) return 146;
    return Math.min(360, Math.max(56, 16 + res.recents.length * 40));
  }
  const apps = res.apps ?? [];
  const bookmarks = res.bookmarks ?? [];
  const files = res.files ?? [];
  const groupCount =
    (apps.length > 0 ? 1 : 0) + (bookmarks.length > 0 ? 1 : 0) + (files.length > 0 ? 1 : 0);
  const rows = apps.length + bookmarks.length + files.length;
  const dividerGap = groupCount > 1 ? (groupCount - 1) * 9 : 0;
  return Math.min(380, Math.max(56, 16 + rows * 40 + dividerGap));
}

export type PipPhase = "max" | "to-pip" | "pip" | "to-max";

export interface AttachedImageItem {
  id: string;
  name: string;
  dataUrl: string;
  entering?: boolean;
  removing?: boolean;
}

export interface SendMessageOptions {
  images?: Array<{ name: string; dataUrl: string }>;
  reasoningEffort?: "none" | "high";
}

const MAX_ATTACHED_IMAGES = 4;
const MAX_IMAGE_EDGE_PX = 1536;

function compressImageDataUrl(rawDataUrl: string, name: string): Promise<{ name: string; dataUrl: string }> {
  return new Promise((resolve) => {
    if (!rawDataUrl || !rawDataUrl.startsWith("data:image/")) {
      resolve({ name, dataUrl: rawDataUrl });
      return;
    }
    // Keep small non-BMP payloads or GIFs intact if already lean (< 320 KB base64)
    if (rawDataUrl.startsWith("data:image/gif") && rawDataUrl.length < 450_000) {
      resolve({ name, dataUrl: rawDataUrl });
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) {
          resolve({ name, dataUrl: rawDataUrl });
          return;
        }
        const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(w, h));
        if (scale >= 1 && rawDataUrl.length < 360_000 && !rawDataUrl.startsWith("data:image/bmp")) {
          resolve({ name, dataUrl: rawDataUrl });
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve({ name, dataUrl: rawDataUrl });
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL("image/jpeg", 0.86);
        resolve({
          name,
          dataUrl: compressed.length < rawDataUrl.length || scale < 1 ? compressed : rawDataUrl,
        });
      } catch {
        resolve({ name, dataUrl: rawDataUrl });
      }
    };
    img.onerror = () => resolve({ name, dataUrl: rawDataUrl });
    img.src = rawDataUrl;
  });
}

function readFileAsCompressedImage(file: File): Promise<{ name: string; dataUrl: string } | null> {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      if (!raw.startsWith("data:image/")) {
        resolve(null);
        return;
      }
      const compressed = await compressImageDataUrl(raw, file.name || "image.png");
      resolve(compressed);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export interface ChatTurn {
  id: string;
  userPrompt?: string | null;
  userImages?: Array<{ name: string; dataUrl: string }>;
  assistantReply: string;
  isStreaming?: boolean;
  connectors?: string[];
  reasoningEffort?: "none" | "high";
  isProactive?: boolean;
}

export interface ConnectorMeta {
  key: string;
  name: string;
  icon: string;
}

export const CONNECTOR_METAS: Record<string, { name: string; icon: string }> = {
  gmail: { name: "Gmail", icon: "/icons/mail.png" },
  mail: { name: "Gmail", icon: "/icons/mail.png" },
  email: { name: "Gmail", icon: "/icons/mail.png" },
  spotify: { name: "Spotify", icon: "/icons/spotify.png" },
  google_calendar: { name: "Google Calendar", icon: "/icons/calendar.png" },
  calendar: { name: "Google Calendar", icon: "/icons/calendar.png" },
  notes_vault: { name: "Notes Vault", icon: "/icons/obsidian.png" },
  notes: { name: "Notes Vault", icon: "/icons/obsidian.png" },
  youtube_visual: { name: "YouTube", icon: "/icons/youtube.png" },
  youtube: { name: "YouTube", icon: "/icons/youtube.png" },
  file_system: { name: "Files", icon: "/icons/explorer.png" },
  files: { name: "Files", icon: "/icons/explorer.png" },
  antigravity_work: { name: "Antigravity Work", icon: "/icons/antigravity.png" },
  antigravity: { name: "Antigravity Work", icon: "/icons/antigravity.png" },
  agy: { name: "Antigravity Work", icon: "/icons/antigravity.png" },
};

export const resolveConnectorMeta = (
  tagOrKey?: string | null,
  explicitConnector?: string | null
): ConnectorMeta | null => {
  if (explicitConnector) {
    const cleanExp = explicitConnector.toLowerCase().trim();
    if (CONNECTOR_METAS[cleanExp]) {
      return { key: cleanExp, ...CONNECTOR_METAS[cleanExp] };
    }
  }
  if (!tagOrKey) return null;
  const lower = tagOrKey.toLowerCase();
  if (
    lower.includes("gmail") ||
    lower.includes("email") ||
    lower.includes("unread") ||
    lower.includes("inbox") ||
    lower.includes("draft")
  ) {
    return { key: "gmail", ...CONNECTOR_METAS.gmail };
  }
  if (lower.includes("spotify") || lower.includes("music")) {
    return { key: "spotify", ...CONNECTOR_METAS.spotify };
  }
  if (lower.includes("calendar")) {
    return { key: "google_calendar", ...CONNECTOR_METAS.google_calendar };
  }
  if (lower.includes("notes") || lower.includes("obsidian")) {
    return { key: "notes_vault", ...CONNECTOR_METAS.notes_vault };
  }
  if (lower.includes("youtube")) {
    return { key: "youtube_visual", ...CONNECTOR_METAS.youtube_visual };
  }
  if (lower.includes("file") || lower.includes("explorer")) {
    return { key: "file_system", ...CONNECTOR_METAS.file_system };
  }
  if (lower.includes("antigravity") || lower.includes("agy") || lower.includes("work mode")) {
    return { key: "antigravity_work", ...CONNECTOR_METAS.antigravity_work };
  }
  return null;
};

interface ChatPillProps {
  isAwake: boolean;
  isDarkMode: boolean;
  isMaxHeight?: boolean;
  turns?: ChatTurn[];
  followupThinkingPrompt?: string | null;
  followupThinkingImages?: Array<{ name: string; dataUrl: string }> | null;
  userPrompt?: string | null;
  onSendMessage?: (message: string, isFollowup?: boolean, options?: SendMessageOptions) => void;
  onToggleSleep?: () => void;
  responseMessage?: string | null;
  activeUiTag?: string | null;
  activeConnector?: string | null;
  isStreaming?: boolean;
  onClearResponse?: () => void;
  contentRef?: React.Ref<HTMLDivElement>;
  isVoiceActive?: boolean;
  onToggleVoice?: (active: boolean) => void;
  isExitingVoice?: boolean;
  isEnteringVoice?: boolean;
  audioMeter?: { level: number; bass: number; mid: number; high: number };
  isRecording?: boolean;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onHardwareChange?: (action: "volume" | "brightness", level?: number, muted?: boolean) => void;
  onSpotifyPlay?: (spotifyId: string, itemType: "track" | "album" | "artist" | "playlist") => void;
  onHeightChange?: (targetH: number, durationMs?: number) => void;
  isBackendOnline?: boolean;
  pipPhase?: PipPhase;
  onMinimizeToPip?: (restoreH: number) => void;
  onMaximizeFromPip?: () => void;
  winMinimizeRef?: React.MutableRefObject<(() => void) | null>;
  agyWorkJob?: AgyWorkJobState | null;
  agyDoneSeq?: number;
  agyFailedSeq?: number;
  proactiveTurnKind?: string | null;
  onDismissAgyCard?: (jobId: string) => void;
  onStopAgyTask?: (jobId: string) => void;
  fileAgentJob?: FileAgentJobState | null;
  onStopFileAgent?: (jobId: string) => void;
  onOpenFilePath?: (path: string, mode: "open" | "reveal") => void;
  onA2UIAction?: (event: A2UIActionEvent) => void;
  browserSession?: { url: string; loading: boolean } | null;
  onCloseBrowser?: () => void;
}

interface MediaGalleryItem {
  url: string;
  title: string;
}

export interface LocationCardData {
  lat: number;
  lon: number;
  title?: string;
}

export interface GmailCardData {
  count?: number;
  emails?: GmailEmailItem[];
  subtitle?: string;
  mode?: "unread" | "search" | "read";
  query?: string;
  id?: string;
  sender?: string;
  email?: string;
  date?: string;
  subject?: string;
  summary?: string;
  avatar?: string;
}

export interface CalendarCardData {
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
  conflicts?: Array<{ summary: string; time: string; location?: string }>;
  suggestedSlot?: string;
}

export interface SystemSliderData {
  type: "volume" | "brightness";
  level: number;
  muted?: boolean;
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "gallery"; items: MediaGalleryItem[] }
  | { type: "loading_gallery" }
  | { type: "location"; data: LocationCardData }
  | { type: "loading_location" }
  | { type: "gmail"; data: GmailCardData }
  | { type: "calendar"; data: CalendarCardData }
  | { type: "system_slider"; data: SystemSliderData }
  | { type: "weather"; data: WeatherCardData }
  | { type: "spotify_artist"; data: SpotifyArtistCardData }
  | { type: "spotify_tracks"; data: SpotifyTracksCardData }
  | { type: "spotify_albums"; data: SpotifyAlbumsCardData }
  | { type: "spotify_playlists"; data: SpotifyPlaylistsCardData }
  | { type: "spotify_library_playlists"; data: SpotifyLibraryPlaylistsCardData }
  | { type: "a2ui"; data: A2UISurfacePayload }
  | { type: "loading_a2ui" }
  | { type: "youtube"; data: YouTubeCardData }
  | { type: "loading_youtube" };

const POLISH_STATUS_TAGS = [
  "Finishing up",
  "Pinpointing details",
  "Last-minute touches",
  "Polishing answer",
  "Synthesizing details",
  "Putting it together",
  "Wrapping up",
  "Dotting the i's",
  "Structuring response",
  "Gathering insights",
  "Almost ready",
];

function getRandomPolishTag(excludeTag?: string | null): string {
  const available = excludeTag
    ? POLISH_STATUS_TAGS.filter((t) => t.toLowerCase() !== excludeTag.toLowerCase())
    : POLISH_STATUS_TAGS;
  const list = available.length > 0 ? available : POLISH_STATUS_TAGS;
  const index = Math.floor(Math.random() * list.length);
  return list[index];
}

function parseSpotifyPlaylistItems(raw: any, maxCount: number): SpotifyPlaylistItem[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((p: any) => p && typeof p === "object")
    .slice(0, maxCount)
    .map((p: any) => ({
      id: String(p.id || ""),
      name: String(p.name || "Unknown Playlist"),
      owner: String(p.owner || "Spotify"),
      isOwner: typeof p.isOwner === "boolean" ? p.isOwner : undefined,
      totalTracks: typeof p.totalTracks === "number" ? p.totalTracks : undefined,
      image: p.image ? String(p.image) : undefined,
      spotifyUrl: p.spotifyUrl ? String(p.spotifyUrl) : undefined,
    }));
}

function normalizeA2UICardPayload(rawPayload: string): A2UISurfacePayload | null {
  const trimmed = (rawPayload || "").trim();
  if (!trimmed) return null;

  const tryParse = (candidate: string): any => {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(candidate.replace(/[\r\n]+/g, " "));
      } catch {
        return null;
      }
    }
  };

  let parsed = tryParse(trimmed);
  // Self-heal shorthand where model omits `{"components":` before `[...],"data_model":...}`
  if (!parsed && trimmed.startsWith("[")) {
    parsed = tryParse(`{"components":${trimmed}`);
    if (!parsed && !trimmed.endsWith("}")) {
      parsed = tryParse(`{"components":${trimmed}}`);
    }
  }
  if (!parsed) return null;

  if (Array.isArray(parsed)) {
    return {
      version: "v0.9",
      createSurface: { surfaceId: "s_a2ui_inline", catalogId: "aiden.glass.v1" },
      updateDataModel: { data: {} },
      updateComponents: { rootId: parsed[0]?.id || "root", components: parsed },
    };
  }
  if (typeof parsed !== "object") return null;

  if (parsed.updateComponents && Array.isArray(parsed.updateComponents.components)) {
    return parsed as A2UISurfacePayload;
  }

  // Normalize shorthand `{ components, data_model, computed, surface_id, root_id }`
  if (Array.isArray(parsed.components)) {
    const sid = String(parsed.surface_id || parsed.surfaceId || "s_a2ui_inline");
    const rootId = String(parsed.root_id || parsed.rootId || parsed.components[0]?.id || "root");
    return {
      version: "v0.9",
      createSurface: { surfaceId: sid, catalogId: "aiden.glass.v1" },
      updateDataModel: {
        surfaceId: sid,
        data: (parsed.data_model || parsed.dataModel || {}) as Record<string, any>,
      },
      updateComponents: {
        surfaceId: sid,
        rootId,
        components: parsed.components,
      },
      computed: parsed.computed,
    };
  }
  return null;
}

function parseMessageWithGalleries(rawText: string, isStreaming: boolean): MessagePart[] {
  if (!rawText) return [];

  const embedRegex = /::(media-(?:gallery|strip)|location-card|gmail-card|calendar-card|system-slider|weather-card|a2ui-card|youtube-card|spotify-(?:artist|tracks|albums|playlists|library-playlists)-card)\[([\s\S]*?)\]::/gi;
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = embedRegex.exec(rawText)) !== null) {
    const textBefore = rawText.slice(lastIndex, match.index);
    if (textBefore) {
      parts.push({ type: "text", text: textBefore });
    }

    const tagType = match[1].toLowerCase();
    const rawPayload = match[2].trim();

    if (tagType === "calendar-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const eventsList: CalendarEventItem[] = Array.isArray(parsed.events)
          ? parsed.events
          : Array.isArray(parsed)
          ? parsed
          : [];
        const count = typeof parsed.count === "number" ? parsed.count : eventsList.length;
        const label = typeof parsed.label === "string" ? parsed.label : undefined;
        const mode =
          parsed.mode === "created"
            ? "created"
            : parsed.mode === "search"
            ? "search"
            : parsed.mode === "updated"
            ? "updated"
            : parsed.mode === "deleted"
            ? "deleted"
            : parsed.mode === "availability"
            ? "availability"
            : "agenda";
        const query = typeof parsed.query === "string" ? parsed.query : undefined;
        const oldTime = typeof parsed.oldTime === "string" ? parsed.oldTime : undefined;
        const newTime = typeof parsed.newTime === "string" ? parsed.newTime : undefined;
        const timeWindow = typeof parsed.timeWindow === "string" ? parsed.timeWindow : undefined;
        const isFree = typeof parsed.isFree === "boolean" ? parsed.isFree : undefined;
        const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : undefined;
        const suggestedSlot = typeof parsed.suggestedSlot === "string" ? parsed.suggestedSlot : undefined;
        const singleEvent = parsed.event && typeof parsed.event === "object" ? parsed.event : undefined;

        parts.push({
          type: "calendar",
          data: {
            mode,
            label,
            count,
            events: eventsList,
            event: singleEvent,
            query,
            oldTime,
            newTime,
            timeWindow,
            isFree,
            conflicts,
            suggestedSlot,
          },
        });
      } catch (err) {
        console.warn("Failed to parse calendar-card JSON:", err);
      }
    } else if (tagType === "gmail-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          // If JSON had line breaks or formatting issues
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const emailsList: GmailEmailItem[] = Array.isArray(parsed.emails)
          ? parsed.emails
          : Array.isArray(parsed)
          ? parsed
          : [];
        const count = typeof parsed.count === "number" ? parsed.count : emailsList.length;
        const subtitle = typeof parsed.subtitle === "string" ? parsed.subtitle : undefined;
        const mode =
          parsed.mode === "read"
            ? "read"
            : parsed.mode === "search" || parsed.query
            ? "search"
            : "unread";
        const query = typeof parsed.query === "string" ? parsed.query : undefined;
        parts.push({
          type: "gmail",
          data: {
            count,
            emails: emailsList,
            subtitle,
            mode,
            query,
            id: typeof parsed.id === "string" || typeof parsed.id === "number" ? String(parsed.id) : undefined,
            sender: typeof parsed.sender === "string" ? parsed.sender : undefined,
            email: typeof parsed.email === "string" ? parsed.email : undefined,
            date: typeof parsed.date === "string" ? parsed.date : undefined,
            subject: typeof parsed.subject === "string" ? parsed.subject : undefined,
            summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
            avatar: typeof parsed.avatar === "string" ? parsed.avatar : undefined,
          },
        });
      } catch (err) {
        console.warn("Failed to parse gmail-card JSON:", err);
      }
    } else if (tagType === "location-card") {
      let lat = 0;
      let lon = 0;
      let title = "";

      const tokens = rawPayload.split("|");
      for (const token of tokens) {
        const [k, ...vParts] = token.split("=");
        const key = k?.trim().toLowerCase();
        const val = vParts.join("=").trim();
        if (key === "lat") {
          lat = parseFloat(val) || 0;
        } else if (key === "lon" || key === "lng") {
          lon = parseFloat(val) || 0;
        } else if (key === "title" || key === "name") {
          title = val;
        }
      }

      if (!lat && !lon) {
        const fallbackParts = rawPayload.split(/[,|]/);
        if (fallbackParts.length >= 2) {
          lat = parseFloat(fallbackParts[0]) || 0;
          lon = parseFloat(fallbackParts[1]) || 0;
          if (fallbackParts.length >= 3) {
            title = fallbackParts.slice(2).join(", ").trim();
          }
        }
      }

      if (lat !== 0 || lon !== 0) {
        parts.push({ type: "location", data: { lat, lon, title } });
      }
    } else if (tagType === "spotify-artist-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        parts.push({
          type: "spotify_artist",
          data: {
            artistId: String(parsed.artistId || ""),
            name: String(parsed.name || "Unknown Artist"),
            image: parsed.image ? String(parsed.image) : undefined,
            verified: parsed.verified !== false,
            monthlyListeners: parsed.monthlyListeners
              ? String(parsed.monthlyListeners)
              : parsed.followers
              ? String(parsed.followers)
              : undefined,
            followers: parsed.followers ? String(parsed.followers) : undefined,
            genres: parsed.genres ? String(parsed.genres) : undefined,
            popularity: typeof parsed.popularity === "number" ? parsed.popularity : undefined,
            spotifyUrl: parsed.spotifyUrl ? String(parsed.spotifyUrl) : undefined,
          },
        });
      } catch (err) {
        console.warn("Failed to parse spotify-artist-card JSON:", err);
      }
    } else if (tagType === "spotify-tracks-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const rawTracks = Array.isArray(parsed.tracks)
          ? parsed.tracks
          : Array.isArray(parsed)
          ? parsed
          : [];
        const tracks: SpotifyTrackItem[] = rawTracks
          .filter((t: any) => t && typeof t === "object")
          .slice(0, 5)
          .map((t: any) => ({
            id: String(t.id || ""),
            name: String(t.name || "Unknown Track"),
            artists: String(t.artists || "Unknown Artist"),
            album: t.album ? String(t.album) : undefined,
            image: t.image ? String(t.image) : undefined,
            duration: t.duration ? String(t.duration) : undefined,
            explicit: Boolean(t.explicit),
            spotifyUrl: t.spotifyUrl ? String(t.spotifyUrl) : undefined,
          }));
        if (tracks.length > 0) {
          parts.push({
            type: "spotify_tracks",
            data: {
              query: parsed.query ? String(parsed.query) : undefined,
              tracks,
            },
          });
        }
      } catch (err) {
        console.warn("Failed to parse spotify-tracks-card JSON:", err);
      }
    } else if (tagType === "spotify-albums-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const rawAlbums = Array.isArray(parsed.albums)
          ? parsed.albums
          : Array.isArray(parsed)
          ? parsed
          : [];
        const albums: SpotifyAlbumItem[] = rawAlbums
          .filter((a: any) => a && typeof a === "object")
          .slice(0, 5)
          .map((a: any) => ({
            id: String(a.id || ""),
            name: String(a.name || "Unknown Album"),
            artists: String(a.artists || "Unknown Artist"),
            totalTracks: typeof a.totalTracks === "number" ? a.totalTracks : undefined,
            year: a.year ? String(a.year) : undefined,
            image: a.image ? String(a.image) : undefined,
            spotifyUrl: a.spotifyUrl ? String(a.spotifyUrl) : undefined,
          }));
        if (albums.length > 0) {
          parts.push({
            type: "spotify_albums",
            data: {
              query: parsed.query ? String(parsed.query) : undefined,
              albums,
            },
          });
        }
      } catch (err) {
        console.warn("Failed to parse spotify-albums-card JSON:", err);
      }
    } else if (tagType === "spotify-playlists-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const rawPlaylists = Array.isArray(parsed.playlists)
          ? parsed.playlists
          : Array.isArray(parsed)
          ? parsed
          : [];
        const playlists = parseSpotifyPlaylistItems(rawPlaylists, 5);
        if (playlists.length > 0) {
          parts.push({
            type: "spotify_playlists",
            data: {
              query: parsed.query ? String(parsed.query) : undefined,
              playlists,
            },
          });
        }
      } catch (err) {
        console.warn("Failed to parse spotify-playlists-card JSON:", err);
      }
    } else if (tagType === "spotify-library-playlists-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const rawPlaylists = Array.isArray(parsed.playlists)
          ? parsed.playlists
          : Array.isArray(parsed)
          ? parsed
          : [];
        const playlists = parseSpotifyPlaylistItems(rawPlaylists, 100);
        if (playlists.length > 0) {
          parts.push({
            type: "spotify_library_playlists",
            data: {
              mode: parsed.mode === "search" ? "search" : "list",
              query: parsed.query ? String(parsed.query) : undefined,
              total: typeof parsed.total === "number" ? parsed.total : undefined,
              playlists,
            },
          });
        }
      } catch (err) {
        console.warn("Failed to parse spotify-library-playlists-card JSON:", err);
      }
    } else if (tagType === "weather-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        parts.push({
          type: "weather",
          data: {
            location: String(parsed.location || "Unknown"),
            temp: Number(parsed.temp ?? 0),
            tempHigh: typeof parsed.tempHigh === "number" ? parsed.tempHigh : undefined,
            tempLow: typeof parsed.tempLow === "number" ? parsed.tempLow : undefined,
            unit: parsed.unit ? String(parsed.unit) : "C",
            condition: String(parsed.condition || "Cloudy"),
            conditionKey: String(parsed.conditionKey || "cloudy"),
            weatherCode: typeof parsed.weatherCode === "number" ? parsed.weatherCode : undefined,
            isDay: typeof parsed.isDay === "boolean" ? parsed.isDay : undefined,
          },
        });
      } catch (err) {
        console.warn("Failed to parse weather-card JSON:", err);
      }
    } else if (tagType === "system-slider") {
      let sliderType: "volume" | "brightness" = "volume";
      let level = 50;
      let muted = false;
      if (rawPayload.startsWith("{")) {
        try {
          const parsed = JSON.parse(rawPayload);
          sliderType = parsed.type === "brightness" ? "brightness" : "volume";
          level = typeof parsed.level === "number" ? parsed.level : parseInt(parsed.level, 10) || 0;
          muted = Boolean(parsed.muted);
        } catch (err) {
          console.warn("Failed to parse system-slider JSON:", err);
        }
      } else {
        const tokens = rawPayload.split("|");
        for (const token of tokens) {
          const [k, ...vParts] = token.split("=");
          const key = k?.trim().toLowerCase();
          const val = vParts.join("=").trim();
          if (key === "type") {
            sliderType = val.toLowerCase() === "brightness" ? "brightness" : "volume";
          } else if (key === "level") {
            level = parseInt(val, 10) || 0;
          } else if (key === "muted") {
            muted = val.toLowerCase() === "true" || val === "1";
          }
        }
      }
      parts.push({
        type: "system_slider",
        data: { type: sliderType, level, muted },
      });
    } else if (tagType === "a2ui-card") {
      const normalized = normalizeA2UICardPayload(rawPayload);
      if (normalized) {
        parts.push({
          type: "a2ui",
          data: normalized,
        });
      } else {
        console.warn("Failed to parse a2ui-card JSON:", rawPayload.slice(0, 120));
      }
    } else if (tagType === "youtube-card") {
      try {
        let parsed: any;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          parsed = JSON.parse(rawPayload.replace(/[\r\n]+/g, " "));
        }
        const rawVideos = Array.isArray(parsed?.videos)
          ? parsed.videos
          : Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && (parsed.videoId || parsed.url)
          ? [parsed]
          : [];
        const videos: YouTubeVideoItem[] = rawVideos
          .filter((v: any) => v && typeof v === "object" && (v.videoId || v.url))
          .slice(0, 4)
          .map((v: any) => {
            const vid = String(v.videoId || "").trim();
            return {
              videoId: vid,
              title: String(v.title || "YouTube Video"),
              channel: String(v.channel || "YouTube"),
              duration: v.duration ? String(v.duration) : undefined,
              views: v.views ? String(v.views) : undefined,
              published: v.published ? String(v.published) : undefined,
              description: v.description ? String(v.description) : undefined,
              thumb: String(v.thumb || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : "")),
              url: String(v.url || (vid ? `https://www.youtube.com/watch?v=${vid}` : "https://www.youtube.com")),
            };
          });
        if (videos.length > 0) {
          parts.push({
            type: "youtube",
            data: {
              mode: parsed?.mode === "suggestion" ? "suggestion" : "search",
              query: parsed?.query ? String(parsed.query) : undefined,
              videos,
            },
          });
        }
      } catch (err) {
        console.warn("Failed to parse youtube-card JSON:", err);
      }
    } else {
      const items: MediaGalleryItem[] = [];

      // Check if JSON format
      if (rawPayload.startsWith("[") || rawPayload.startsWith("{")) {
        try {
          const parsed = JSON.parse(rawPayload);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of list) {
            if (item && typeof item === "object") {
              const u = item.thumbnail || item.url;
              if (u) {
                items.push({
                  url: String(u),
                  title: String(item.title || item.caption || "").trim(),
                });
              }
            }
          }
        } catch {
          // Fallback to text parsing
        }
      }

      // Comma-separated: "url | caption, url | caption"
      if (items.length === 0) {
        const entries = rawPayload.split(/,(?=\s*https?:\/\/|\s*["'{])/g);
        for (const entry of entries) {
          const trimmed = entry.trim().replace(/^["']|["']$/g, "");
          if (!trimmed) continue;
          if (trimmed.includes("|")) {
            const [u, ...rest] = trimmed.split("|");
            items.push({
              url: u.trim(),
              title: rest.join("|").trim(),
            });
          } else {
            const tokens = trimmed.split(/\s+/);
            const u = tokens[0];
            const t = tokens.slice(1).join(" ");
            if (u.startsWith("http")) {
              items.push({ url: u, title: t });
            }
          }
        }
      }

      if (items.length > 0) {
        parts.push({ type: "gallery", items });
      }
    }
    lastIndex = embedRegex.lastIndex;
  }

  const remaining = rawText.slice(lastIndex);
  if (remaining) {
    const partialMatch = /::(media-(?:gallery|strip)|location-card|gmail-card|calendar-card|system-slider|weather-card|a2ui-card|youtube-card|spotify-(?:artist|tracks|albums|playlists|library-playlists)-card)\[([\s\S]*)$/i.exec(remaining);
    if (partialMatch && isStreaming) {
      const textBeforePartial = remaining.slice(0, partialMatch.index);
      if (textBeforePartial) {
        parts.push({ type: "text", text: textBeforePartial });
      }
      if (partialMatch[1].toLowerCase().startsWith("media")) {
        parts.push({ type: "loading_gallery" });
      } else if (partialMatch[1].toLowerCase().startsWith("location")) {
        parts.push({ type: "loading_location" });
      } else if (partialMatch[1].toLowerCase() === "a2ui-card") {
        parts.push({ type: "loading_a2ui" });
      } else if (partialMatch[1].toLowerCase() === "youtube-card") {
        parts.push({ type: "loading_youtube" });
      }
    } else if (partialMatch && !isStreaming && partialMatch[1].toLowerCase() === "a2ui-card") {
      // Self-heal unclosed ::a2ui-card[...] if a model dropped the trailing ]::
      const textBeforePartial = remaining.slice(0, partialMatch.index);
      if (textBeforePartial) {
        parts.push({ type: "text", text: textBeforePartial });
      }
      const recovered = normalizeA2UICardPayload("[" + partialMatch[2]);
      if (recovered) {
        parts.push({ type: "a2ui", data: recovered });
      } else {
        const directRecovered = normalizeA2UICardPayload(partialMatch[2]);
        if (directRecovered) {
          parts.push({ type: "a2ui", data: directRecovered });
        } else {
          parts.push({ type: "text", text: remaining });
        }
      }
    } else {
      parts.push({ type: "text", text: remaining });
    }
  }

  return parts;
}

export const AppleConstellationSpinner: React.FC = () => (
  <svg className="constellation-svg" width="22" height="22" viewBox="0 0 24 24" fill="none">
    <circle className="c-dot c-dot-1" cx="12" cy="3.5" r="1.6" fill="currentColor" />
    <circle className="c-dot c-dot-2" cx="18" cy="6" r="1.6" fill="currentColor" />
    <circle className="c-dot c-dot-3" cx="20.5" cy="12" r="1.6" fill="currentColor" />
    <circle className="c-dot c-dot-4" cx="18" cy="18" r="1.6" fill="currentColor" />
    <circle className="c-dot c-dot-5" cx="12" cy="20.5" r="1.6" fill="currentColor" />
    <circle className="c-dot c-dot-6" cx="6" cy="18" r="1.6" fill="currentColor" />
    <circle className="c-dot c-dot-7" cx="3.5" cy="12" r="1.6" fill="currentColor" />
    <circle className="c-dot c-dot-8" cx="6" cy="6" r="1.6" fill="currentColor" />
  </svg>
);

interface RackStatusLayer {
  key: number;
  text: string;
  animate: boolean;
}

/**
 * Transitions status labels via an optical rack-focus bloom instead of hard-swapping DOM text.
 */
const MorphingStatusText: React.FC<{
  text: string;
  className: string;
}> = React.memo(({ text, className }) => {
  const seqRef = useRef(0);
  const currentTextRef = useRef(text);
  const exitTimerRef = useRef<number | null>(null);
  const [layers, setLayers] = useState<{
    exiting: RackStatusLayer | null;
    current: RackStatusLayer;
  }>(() => ({
    exiting: null,
    current: { key: 0, text, animate: false },
  }));

  useLayoutEffect(() => {
    if (text === currentTextRef.current) return;
    const prevText = currentTextRef.current;
    currentTextRef.current = text;

    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    const exitKey = ++seqRef.current;
    const enterKey = ++seqRef.current;

    setLayers({
      exiting: prevText ? { key: exitKey, text: prevText, animate: true } : null,
      current: { key: enterKey, text, animate: true },
    });

    // Exit animation runs 200ms; retain briefly to avoid popping before final frame.
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setLayers((prev) => (prev.exiting ? { ...prev, exiting: null } : prev));
    }, 240);
  }, [text]);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  return (
    <span className="siri-status-rack-slot">
      {layers.exiting && (
        <span
          key={layers.exiting.key}
          className={`siri-status-rack-layer ${className} is-rack-exiting`}
          aria-hidden="true"
        >
          {layers.exiting.text}
        </span>
      )}
      <span
        key={layers.current.key}
        className={`siri-status-rack-layer ${className}${layers.current.animate ? " is-rack-entering" : ""}`}
      >
        {layers.current.text}
      </span>
    </span>
  );
});

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smoothstep = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeLaunchGlide = (x: number) => easeInOutCubic(Math.pow(clamp01(x), 0.88));

function animateStreamScroll(
  container: HTMLElement,
  targetTop: number,
  durationMs: number,
  rafRef: React.MutableRefObject<number | null>,
  cancelled: { current: boolean },
  onTick: () => void,
  onDone?: () => void
) {
  if (rafRef.current !== null) {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }
  const startTop = container.scrollTop;
  const delta = targetTop - startTop;
  if (Math.abs(delta) < 2) {
    container.scrollTop = targetTop;
    onTick();
    if (onDone) onDone();
    return;
  }
  const startTs = performance.now();
  const step = (now: number) => {
    if (cancelled.current || !container.isConnected) {
      rafRef.current = null;
      return;
    }
    const u = Math.min(1, (now - startTs) / durationMs);
    const eased = 1 - Math.pow(1 - u, 3.6);
    container.scrollTop = startTop + delta * eased;
    onTick();
    if (u < 1) {
      rafRef.current = requestAnimationFrame(step);
    } else {
      rafRef.current = null;
      if (onDone) onDone();
    }
  };
  rafRef.current = requestAnimationFrame(step);
}

interface FollowupBubbleFlightOpts {
  wrapEl: HTMLElement;
  bubble: HTMLElement;
  labelEl: HTMLElement | null;
  statusEl: HTMLElement | null;
  barEl: HTMLElement | null;
  streamEl: HTMLElement;
  rafIdsRef: React.MutableRefObject<number[]>;
  cancelled: { current: boolean };
}

function animateFollowupBubbleFlight({
  wrapEl,
  bubble,
  labelEl,
  statusEl,
  barEl,
  streamEl,
  rafIdsRef,
  cancelled,
}: FollowupBubbleFlightOpts) {
  if (cancelled.current || !bubble.isConnected || !wrapEl.isConnected) return;

  const fallbackEl = streamEl.parentElement ?? streamEl;
  const barRect = barEl ? barEl.getBoundingClientRect() : fallbackEl.getBoundingClientRect();
  const wrapRect0 = wrapEl.getBoundingClientRect();
  const width = bubble.offsetWidth || 180;
  const height = bubble.offsetHeight || 38;
  const dotBase = Math.min(28, Math.max(18, height - 6));
  const dotTop = Math.max(0, height - dotBase);
  const dotLeft = Math.max(0, width - dotBase);
  const isLight = Boolean(bubble.closest(".light-mode"));
  const spawnScreenY = barEl ? barRect.bottom - 12 : barRect.bottom - 26;
  const restBottomY0 = wrapRect0.top + height;
  const initialDy = Math.max(160, Math.round(spawnScreenY - restBottomY0));

  // Synchronously initialize dot state before removing .bubble-awaiting to avoid any 1-frame flash
  bubble.style.opacity = "0";
  bubble.style.setProperty("--tail-op", "0");
  bubble.style.setProperty("--tail-scale", "0.35");
  bubble.style.clipPath = `inset(${dotTop.toFixed(1)}px 0px 0px ${dotLeft.toFixed(1)}px round 999px)`;
  bubble.style.transform = `translate3d(0, ${initialDy.toFixed(2)}px, 0) scale(0.44, 0.44)`;
  if (labelEl) labelEl.style.opacity = "0";
  bubble.classList.remove("bubble-awaiting");
  bubble.classList.add("bubble-spawning");

  let statusShown = false;
  const startTs = performance.now();
  const TOTAL_SEC = 1.42;

  const runFrame = (now: number) => {
    if (cancelled.current || !bubble.isConnected || !wrapEl.isConnected) return;
    const t = (now - startTs) / 1000;

    // Live resting slot tracks concurrent auto-scroll cleanly frame-by-frame
    const liveRestBottomY = wrapEl.getBoundingClientRect().top + height;
    const liveDy = Math.max(0, spawnScreenY - liveRestBottomY);

    // 1. Dot fades in cleanly right under command bar (0..120ms)
    const fadeP = easeOutCubic(Math.min(1, t / 0.12));

    // 2. Smooth vertical ascent along right edge -> feeds continuously into damped spring bounce
    const tauLift = Math.max(0, t - 0.02);
    const liftU = Math.min(1, tauLift / 0.56);
    const carrierY = liveDy * (1 - easeLaunchGlide(liftU));

    const tb = Math.max(0, t - 0.40);
    const ramp = tb < 0.14 ? Math.sin((tb / 0.14) * (Math.PI / 2)) : 1;
    const tailFade = t > 1.22 ? 1 - smoothstep((t - 1.22) / 0.2) : 1;
    const bounceY = -18 * ramp * tailFade * Math.exp(-2.85 * tb) * Math.sin(10.2 * tb);
    const curY = carrierY + bounceY;

    // 3. Smooth dot-to-pill clip-path unfolding along right edge
    const expU = Math.max(0, Math.min(1, (t - 0.08) / 0.44));
    const expP = easeInOutCubic(expU);
    const padOpen = smoothstep((t - 0.50) / 0.16);

    const clipT = dotTop * (1 - expP) - 8 * padOpen;
    const clipR = -8 * padOpen;
    const clipB = -12 * padOpen;
    const clipL = dotLeft * (1 - expP) - 8 * padOpen;
    const clipRad = 999 - (999 - 22) * Math.pow(expP, 0.35);

    const baseScale = 0.44 + 0.56 * easeOutCubic(Math.min(1, t / 0.48));
    const elasticY = 1 - 0.0022 * bounceY;
    const elasticX = 1 + 0.0012 * bounceY;

    bubble.style.opacity = fadeP.toFixed(3);
    bubble.style.transform = `translate3d(0, ${curY.toFixed(2)}px, 0) scale(${(baseScale * elasticX).toFixed(4)}, ${(baseScale * elasticY).toFixed(4)})`;
    bubble.style.clipPath = `inset(${clipT.toFixed(1)}px ${clipR.toFixed(1)}px ${clipB.toFixed(1)}px ${clipL.toFixed(1)}px round ${clipRad.toFixed(1)}px)`;

    if (!isLight) {
      const sheen = smoothstep((t - 0.12) / 0.36);
      const r = Math.round(70 + (47 - 70) * sheen);
      const g = Math.round(69 + (46 - 69) * sheen);
      const b = Math.round(88 + (58 - 88) * sheen);
      bubble.style.background = `rgb(${r}, ${g}, ${b})`;
    }

    if (labelEl) {
      labelEl.style.opacity = smoothstep((t - 0.22) / 0.24).toFixed(3);
    }
    const tailP = smoothstep((t - 0.50) / 0.18);
    bubble.style.setProperty("--tail-op", tailP.toFixed(3));
    bubble.style.setProperty("--tail-scale", (0.35 + 0.65 * tailP).toFixed(3));

    // Phase 3: Reveal left-aligned status tag cleanly as bubble starts springing into position
    if (!statusShown && t >= 0.56) {
      statusShown = true;
      if (statusEl) {
        statusEl.classList.remove("status-awaiting");
        statusEl.classList.add("status-reveal");
      }
    }

    if (t < TOTAL_SEC) {
      const rid = requestAnimationFrame(runFrame);
      rafIdsRef.current.push(rid);
    } else {
      bubble.classList.remove("bubble-spawning");
      bubble.style.opacity = "";
      bubble.style.transform = "";
      bubble.style.clipPath = "";
      bubble.style.background = "";
      bubble.style.removeProperty("--tail-op");
      bubble.style.removeProperty("--tail-scale");
      if (labelEl) labelEl.style.opacity = "";
      if (!statusShown && statusEl) {
        statusEl.classList.remove("status-awaiting");
        statusEl.classList.add("status-reveal");
      }
    }
  };

  const rid0 = requestAnimationFrame(runFrame);
  rafIdsRef.current.push(rid0);
}

export const ChatPill: React.FC<ChatPillProps> = ({
  isAwake,
  isDarkMode,
  isMaxHeight = false,
  turns,
  followupThinkingPrompt = null,
  followupThinkingImages = [],
  userPrompt = null,
  onSendMessage,
  onToggleSleep,
  responseMessage = null,
  activeUiTag = null,
  activeConnector = null,
  isStreaming = false,
  onClearResponse: _onClearResponse,
  contentRef,
  isVoiceActive,
  onToggleVoice,
  isExitingVoice,
  isEnteringVoice,
  audioMeter = { level: 0, bass: 0, mid: 0, high: 0 },
  isRecording = false,
  onStartRecording: _onStartRecording,
  onStopRecording: _onStopRecording,
  onHardwareChange,
  onSpotifyPlay,
  onHeightChange,
  isBackendOnline = true,
  pipPhase = "max",
  onMinimizeToPip,
  onMaximizeFromPip,
  winMinimizeRef,
  agyWorkJob = null,
  agyDoneSeq = 0,
  agyFailedSeq = 0,
  proactiveTurnKind = null,
  onDismissAgyCard,
  onStopAgyTask,
  fileAgentJob = null,
  onStopFileAgent,
  onOpenFilePath,
  onA2UIAction,
  browserSession = null,
  onCloseBrowser,
}) => {
  void _onClearResponse;
  void _onStartRecording;
  void _onStopRecording;
  const isConnecting = Boolean(
    activeUiTag && activeUiTag.toLowerCase().includes("connecting")
  );
  const activeConnectorMeta = isConnecting ? resolveConnectorMeta(activeUiTag, activeConnector) : null;
  const [inputText, setInputText] = useState("");
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;
  const [localVoiceActive, setLocalVoiceActive] = useState(false);
  const voiceActive = isVoiceActive !== undefined ? isVoiceActive : localVoiceActive;

  const [localExitingVoice, setLocalExitingVoice] = useState(false);
  const localExitingTimerRef = useRef<number | null>(null);
  const effectiveExitingVoice = isExitingVoice !== undefined ? isExitingVoice : localExitingVoice;

  const [localEnteringVoice, setLocalEnteringVoice] = useState(false);
  const localEnteringTimerRef = useRef<number | null>(null);
  const effectiveEnteringVoice = isEnteringVoice !== undefined ? isEnteringVoice : localEnteringVoice;

  const [isExpandedVoiceReturning, setIsExpandedVoiceReturning] = useState(false);
  const expandedVoiceReturnTimerRef = useRef<number | null>(null);
  const [isExpandedVoiceCascading, setIsExpandedVoiceCascading] = useState(false);
  const expandedVoiceCascadeTimerRef = useRef<number | null>(null);

  const toggleVoiceMode = (active: boolean) => {
    const isResponding = pillMode === "responding";

    if (!active && voiceActive) {
      if (isResponding) {
        setIsExpandedVoiceCascading(false);
        if (expandedVoiceCascadeTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceCascadeTimerRef.current);
          expandedVoiceCascadeTimerRef.current = null;
        }
        setIsExpandedVoiceReturning(true);
        if (expandedVoiceReturnTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceReturnTimerRef.current);
        }
        expandedVoiceReturnTimerRef.current = window.setTimeout(() => {
          setIsExpandedVoiceReturning(false);
          expandedVoiceReturnTimerRef.current = null;
        }, 520);
      } else {
        setLocalEnteringVoice(false);
        if (localEnteringTimerRef.current !== null) {
          window.clearTimeout(localEnteringTimerRef.current);
          localEnteringTimerRef.current = null;
        }
        setLocalExitingVoice(true);
        if (localExitingTimerRef.current !== null) {
          window.clearTimeout(localExitingTimerRef.current);
        }
        localExitingTimerRef.current = window.setTimeout(() => {
          setLocalExitingVoice(false);
          localExitingTimerRef.current = null;
        }, 480);
      }
    } else if (active) {
      if (isResponding) {
        setIsExpandedVoiceReturning(false);
        if (expandedVoiceReturnTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceReturnTimerRef.current);
          expandedVoiceReturnTimerRef.current = null;
        }
        setIsExpandedVoiceCascading(true);
        if (expandedVoiceCascadeTimerRef.current !== null) {
          window.clearTimeout(expandedVoiceCascadeTimerRef.current);
        }
        expandedVoiceCascadeTimerRef.current = window.setTimeout(() => {
          setIsExpandedVoiceCascading(false);
          expandedVoiceCascadeTimerRef.current = null;
        }, 320);
        followupInputRef.current?.blur();
        setIsInputFocused(false);
      } else {
        setLocalExitingVoice(false);
        if (localExitingTimerRef.current !== null) {
          window.clearTimeout(localExitingTimerRef.current);
          localExitingTimerRef.current = null;
        }
        setLocalEnteringVoice(true);
        if (localEnteringTimerRef.current !== null) {
          window.clearTimeout(localEnteringTimerRef.current);
        }
        localEnteringTimerRef.current = window.setTimeout(() => {
          setLocalEnteringVoice(false);
          localEnteringTimerRef.current = null;
        }, 160);
      }
    }
    setLocalVoiceActive(active);
    if (onToggleVoice) onToggleVoice(active);
  };

  useEffect(() => {
    return () => {
      if (localExitingTimerRef.current !== null) {
        window.clearTimeout(localExitingTimerRef.current);
      }
      if (localEnteringTimerRef.current !== null) {
        window.clearTimeout(localEnteringTimerRef.current);
      }
      if (expandedVoiceReturnTimerRef.current !== null) {
        window.clearTimeout(expandedVoiceReturnTimerRef.current);
      }
      if (expandedVoiceCascadeTimerRef.current !== null) {
        window.clearTimeout(expandedVoiceCascadeTimerRef.current);
      }
    };
  }, []);

  // Dynamic 2D Shining Cursor tracking (supports single-line, multiline, scrolling, and follow-up capsule)
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const [caretPos, setCaretPos] = useState<{ left: number; top: number; visible: boolean }>({
    left: 0,
    top: 2,
    visible: true,
  });

  const [isMultiline, setIsMultiline] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [drawerForceOpen, setDrawerForceOpen] = useState(false);
  const [drawerSelectedIndex, setDrawerSelectedIndex] = useState(-1);
  const [searchResult, setSearchResult] = useState<UnifiedSearchResponse | null>(null);
  const searchReqGenRef = useRef<number>(0);
  const searchDebounceRef = useRef<number | null>(null);
  const drawerVisiblePrevRef = useRef<boolean>(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isPipDragging, setIsPipDragging] = useState(false);
  const [isPipDimmed, setIsPipDimmed] = useState(false);
  const [pipRimTone, setPipRimTone] = useState<"none" | "green" | "red" | "amber" | "music" | "work_green">("none");
  const [announcementBlockPulse, setAnnouncementBlockPulse] = useState(false);
  const announcementBlockTimerRef = useRef<number | null>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImageItem[]>([]);
  const attachedImagesRef = useRef<AttachedImageItem[]>([]);
  attachedImagesRef.current = attachedImages;
  const [deepReason, setDeepReason] = useState(false);
  const [isPlusTrayOpen, setIsPlusTrayOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef<number>(0);
  const removeTimersRef = useRef<Set<number>>(new Set());

  const activeImages = attachedImages.filter((im) => !im.removing);
  const hasActiveImages = activeImages.length > 0;
  const hasFollowupPending = Boolean(
    followupThinkingPrompt || (followupThinkingImages && followupThinkingImages.length > 0)
  );

  const handleDragVisualChange = useCallback((dragging: boolean, dimmed: boolean) => {
    setIsPipDragging((prev) => (prev !== dragging ? dragging : prev));
    setIsPipDimmed((prev) => (prev !== dimmed ? dimmed : prev));
  }, []);

  useEffect(() => {
    if (pipPhase === "max") {
      setIsPipDragging(false);
      setIsPipDimmed(false);
      setPipRimTone("none");
    }
  }, [pipPhase]);
  const followupInputRef = useRef<HTMLTextAreaElement>(null);
  const pillInputRef = useRef<HTMLTextAreaElement>(null);
  const lastIdleReportedHRef = useRef<number>(60);
  const lastTextareaIdleHRef = useRef<number>(60);
  const [followupExtraH, setFollowupExtraH] = useState<number>(0);
  const pillMirrorRef = useRef<HTMLDivElement>(null);
  const pillMarkerRef = useRef<HTMLSpanElement>(null);
  const followupMirrorRef = useRef<HTMLDivElement>(null);
  const followupMarkerRef = useRef<HTMLSpanElement>(null);
  const streamContainerRef = useRef<HTMLDivElement>(null);
  const followupBarRef = useRef<HTMLDivElement>(null);
  const pendingWrapRef = useRef<HTMLDivElement>(null);
  const pendingBubbleRef = useRef<HTMLDivElement>(null);
  const pendingLabelRef = useRef<HTMLSpanElement>(null);
  const pendingStatusRef = useRef<HTMLDivElement>(null);
  const scrollAnimRafRef = useRef<number | null>(null);
  const bubbleAnimRafIdsRef = useRef<number[]>([]);
  const sleepBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const plusBtnRef = useRef<HTMLDivElement>(null);
  const capsuleRef = useRef<HTMLDivElement>(null);
  const micBtnRef = useRef<HTMLButtonElement>(null);
  const lensFilterRef = useRef<SVGFilterElement>(null);
  const lensMaskImgRef = useRef<SVGFEImageElement>(null);
  const lensRafIdRef = useRef<number | null>(null);
  const lensSyncUntilRef = useRef<number>(0);
  const lensHideTimerRef = useRef<number | null>(null);
  const lastLensSigRef = useRef<string>("");
  const [isLensBlurActive, setIsLensBlurActive] = useState(false);

  // Scroll-to-Bottom Mini Pill ("↓ Latest") detaching from the Ask Aiden capsule
  const [scrollBottomState, setScrollBottomState] = useState<"hidden" | "visible" | "leaving">("hidden");
  const scrollBottomStateRef = useRef<"hidden" | "visible" | "leaving">("hidden");
  const scrollBottomLeaveTimerRef = useRef<number | null>(null);
  const scrollBottomAnchorRef = useRef<HTMLDivElement>(null);
  const scrollBottomBtnRef = useRef<HTMLButtonElement>(null);
  const scrollBottomRimRef = useRef<HTMLDivElement>(null);
  const scrollBottomCancelRef = useRef<{ current: boolean }>({ current: false });

  // Dynamic Island wake/hide choreography phase for inner content stagger
  const prevBloomStateRef = useRef<{ isAwake: boolean; isBackendOnline: boolean }>({
    isAwake,
    isBackendOnline,
  });
  const wakePhaseTimerRef = useRef<number | null>(null);
  const [wakePhase, setWakePhase] = useState<"idle" | "waking" | "hiding">("idle");

  useEffect(() => {
    const prev = prevBloomStateRef.current;
    prevBloomStateRef.current = { isAwake, isBackendOnline };
    if (prev.isAwake === isAwake && prev.isBackendOnline === isBackendOnline) return;

    if (wakePhaseTimerRef.current !== null) {
      window.clearTimeout(wakePhaseTimerRef.current);
      wakePhaseTimerRef.current = null;
    }

    if (!isBackendOnline) {
      if (prev.isBackendOnline || prev.isAwake) {
        setWakePhase("hiding");
        wakePhaseTimerRef.current = window.setTimeout(() => {
          setWakePhase("idle");
          wakePhaseTimerRef.current = null;
        }, 280);
      } else {
        setWakePhase("idle");
      }
      return;
    }

    if (!prev.isAwake && isAwake) {
      setWakePhase("waking");
      wakePhaseTimerRef.current = window.setTimeout(() => {
        setWakePhase("idle");
        wakePhaseTimerRef.current = null;
      }, 360);
    } else {
      setWakePhase("idle");
    }
  }, [isAwake, isBackendOnline]);

  useEffect(() => {
    return () => {
      if (wakePhaseTimerRef.current !== null) {
        window.clearTimeout(wakePhaseTimerRef.current);
      }
    };
  }, []);

  const showScrollBottomPill = useCallback(() => {
    if (scrollBottomLeaveTimerRef.current !== null) {
      window.clearTimeout(scrollBottomLeaveTimerRef.current);
      scrollBottomLeaveTimerRef.current = null;
    }
    if (scrollBottomStateRef.current === "visible") return;
    scrollBottomStateRef.current = "visible";
    setScrollBottomState("visible");
    const bloomEl = scrollBottomRimRef.current;
    if (bloomEl) {
      bloomEl.classList.remove("pulse");
      void bloomEl.offsetWidth;
      bloomEl.classList.add("pulse");
    }
  }, []);

  const hideScrollBottomPill = useCallback((immediate = false) => {
    if (scrollBottomStateRef.current === "hidden") return;
    if (immediate) {
      if (scrollBottomLeaveTimerRef.current !== null) {
        window.clearTimeout(scrollBottomLeaveTimerRef.current);
        scrollBottomLeaveTimerRef.current = null;
      }
      scrollBottomStateRef.current = "hidden";
      setScrollBottomState("hidden");
      return;
    }
    if (scrollBottomStateRef.current === "leaving") return;
    scrollBottomStateRef.current = "leaving";
    setScrollBottomState("leaving");
    if (scrollBottomLeaveTimerRef.current !== null) {
      window.clearTimeout(scrollBottomLeaveTimerRef.current);
    }
    scrollBottomLeaveTimerRef.current = window.setTimeout(() => {
      scrollBottomLeaveTimerRef.current = null;
      scrollBottomStateRef.current = "hidden";
      setScrollBottomState("hidden");
    }, 220);
  }, []);

  const updateScrollMask = useCallback(() => {
    const el = streamContainerRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    const maxScroll = scrollHeight - clientHeight;

    if (maxScroll <= 4) {
      hideScrollBottomPill();
      if (el.dataset.currentMask !== "none") {
        el.dataset.currentMask = "none";
        el.style.maskImage = "none";
        el.style.webkitMaskImage = "none";
      }
      return;
    }

    const topFade = scrollTop <= 4 ? 0 : Math.min(20, scrollTop);
    const bottomRemaining = maxScroll - scrollTop;
    const bottomFade = bottomRemaining <= 4 ? 0 : Math.min(34, bottomRemaining);

    if (bottomRemaining > 42) {
      showScrollBottomPill();
    } else if (bottomRemaining <= 16) {
      hideScrollBottomPill();
    }

    let mask = "none";
    if (topFade > 0 && bottomFade > 0) {
      mask = `linear-gradient(to bottom, transparent 0%, black ${topFade}px, black calc(100% - ${bottomFade}px), transparent 100%)`;
    } else if (bottomFade > 0) {
      mask = `linear-gradient(to bottom, black 0%, black calc(100% - ${bottomFade}px), transparent 100%)`;
    } else if (topFade > 0) {
      mask = `linear-gradient(to bottom, transparent 0%, black ${topFade}px, black 100%)`;
    }

    if (el.dataset.currentMask !== mask) {
      el.dataset.currentMask = mask;
      el.style.maskImage = mask;
      el.style.webkitMaskImage = mask;
    }
  }, [hideScrollBottomPill, showScrollBottomPill]);

  const handleScrollToBottom = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const container = streamContainerRef.current;
      if (!container) return;
      scrollBottomCancelRef.current.current = true;
      const cancelToken = { current: false };
      scrollBottomCancelRef.current = cancelToken;
      const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
      animateStreamScroll(container, targetTop, 380, scrollAnimRafRef, cancelToken, updateScrollMask);
    },
    [updateScrollMask]
  );

  useEffect(() => {
    return () => {
      scrollBottomCancelRef.current.current = true;
      if (scrollBottomLeaveTimerRef.current !== null) {
        window.clearTimeout(scrollBottomLeaveTimerRef.current);
      }
    };
  }, []);

  const activeTurns: ChatTurn[] = turns && turns.length > 0
    ? turns
    : responseMessage
    ? [{ id: "single-turn", userPrompt: null, assistantReply: responseMessage, isStreaming }]
    : [];

  const isAgyRunning = Boolean(agyWorkJob && agyWorkJob.status === "running");
  const showInlineAgyCard = Boolean(agyWorkJob && !agyWorkJob.cardDismissed);
  const isProactiveAnnouncementActive = proactiveTurnKind === "agy_done";

  const hasTurns = activeTurns.some((t) =>
    Boolean((t.assistantReply && t.assistantReply.trim().length > 0) || t.userPrompt || (t.userImages && t.userImages.length > 0))
  );
  const hasReplyText =
    hasTurns ||
    Boolean((responseMessage && responseMessage.length > 0) || hasFollowupPending) ||
    Boolean(showInlineAgyCard && isAgyRunning) ||
    Boolean(fileAgentJob && fileAgentJob.status === "scan");
  const isThinking = Boolean(!hasReplyText && (activeUiTag || isSubmitting));
  const isProactiveThinkingInStream = Boolean(
    !hasFollowupPending && activeUiTag && proactiveTurnKind && hasReplyText
  );

  const pillMode: "idle" | "listening" | "thinking" | "responding" = hasReplyText
    ? "responding"
    : isThinking
    ? "thinking"
    : voiceActive
    ? "listening"
    : "idle";

  const showReplyWindow = pillMode === "responding";

  // Shared Apple Siri Fluid Aurora Vocal Energy & Intensity
  const rawVocal = Math.max(
    audioMeter.level || 0,
    (audioMeter.mid || 0) * 0.95,
    (audioMeter.bass || 0) * 0.75
  );
  const voiceIntensity = isRecording
    ? Math.min(1.0, Math.pow(rawVocal * 2.0, 0.75))
    : 0;
  const activeScaleY = 1 + voiceIntensity * 0.48;
  const activeScaleX = 1 + voiceIntensity * 0.09;

  // Controls (minimize button and command bar) stay visible on hover, focus, draft text, open [+] tray, attached images, or active drag-over
  const isControlsVisible = Boolean(
    !voiceActive &&
      pipPhase === "max" &&
      (isHovered || isInputFocused || inputText.length > 0 || isPlusTrayOpen || hasActiveImages || isDragOver)
  );

  const respondingMountedAtRef = useRef<number>(0);

  // Reset hover & transient trays when entering or leaving responding mode
  useEffect(() => {
    if (pillMode === "responding") {
      respondingMountedAtRef.current = Date.now();
      setIsHovered(false);
    } else {
      setIsHovered(false);
      setIsPlusTrayOpen(false);
    }
  }, [pillMode]);

  // Reset attached images & Deep Reason cleanly when putting AIDEN to sleep (× / Esc) — preserved across PiP minimize!
  const prevAwakeForAttachmentsRef = useRef<boolean>(isAwake);
  useEffect(() => {
    const wasAwake = prevAwakeForAttachmentsRef.current;
    prevAwakeForAttachmentsRef.current = isAwake;
    if (wasAwake && !isAwake) {
      setAttachedImages([]);
      setDeepReason(false);
      setIsPlusTrayOpen(false);
      setIsDragOver(false);
      dragDepthRef.current = 0;
    }
  }, [isAwake]);

  useEffect(() => {
    return () => {
      removeTimersRef.current.forEach((id) => window.clearTimeout(id));
      removeTimersRef.current.clear();
    };
  }, []);

  const attachCompressedImages = useCallback((items: Array<{ name: string; dataUrl: string }>) => {
    if (!items || items.length === 0) return;
    const addedIds: string[] = [];
    setAttachedImages((prev) => {
      const currentActive = prev.filter((x) => !x.removing).length;
      const slots = Math.max(0, MAX_ATTACHED_IMAGES - currentActive);
      if (slots <= 0) return prev;
      const toAdd: AttachedImageItem[] = items
        .slice(0, slots)
        .filter((it) => it && it.dataUrl && it.dataUrl.startsWith("data:image/"))
        .map((it) => {
          const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          addedIds.push(id);
          return {
            id,
            name: it.name || "image.png",
            dataUrl: it.dataUrl,
            entering: true,
            removing: false,
          };
        });
      return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
    });
    if (addedIds.length > 0) {
      setIsPlusTrayOpen(false);
      setDrawerForceOpen(false);
      setDrawerSelectedIndex(-1);
      setSearchResult(null);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setAttachedImages((prev) =>
            prev.map((im) => (addedIds.includes(im.id) ? { ...im, entering: false } : im))
          );
        });
      });
    }
  }, []);

  const handleImageFileList = useCallback(
    async (fileList: FileList | File[] | null | undefined) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList).filter((f) => f && f.type && f.type.startsWith("image/"));
      if (files.length === 0) return;
      const currentActive = attachedImagesRef.current.filter((x) => !x.removing).length;
      const slots = Math.max(0, MAX_ATTACHED_IMAGES - currentActive);
      if (slots <= 0) return;
      const processed = await Promise.all(files.slice(0, slots).map(readFileAsCompressedImage));
      const valid = processed.filter((x): x is { name: string; dataUrl: string } => Boolean(x));
      attachCompressedImages(valid);
    },
    [attachCompressedImages]
  );

  const removeImageOrganically = useCallback((id: string) => {
    setAttachedImages((prev) =>
      prev.map((im) => (im.id === id ? { ...im, removing: true } : im))
    );
    const tid = window.setTimeout(() => {
      removeTimersRef.current.delete(tid);
      setAttachedImages((prev) => prev.filter((im) => im.id !== id));
    }, 310);
    removeTimersRef.current.add(tid);
  }, []);

  // Native Tauri v2 OS File Drag-and-Drop listener (works across both Compact Idle Pill & Expanded Chat!)
  useEffect(() => {
    const canAcceptDrop = Boolean(
      isAwake && pipPhase === "max" && !voiceActive && (pillMode === "idle" || pillMode === "responding")
    );
    if (!canAcceptDrop) {
      setIsDragOver(false);
      return;
    }

    let disposed = false;
    let unlistenDrop: (() => void) | undefined;

    const attachDrop = async () => {
      try {
        const unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (disposed) return;
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsDragOver(true);
          } else if (payload.type === "leave") {
            setIsDragOver(false);
          } else if (payload.type === "drop") {
            setIsDragOver(false);
            const paths = Array.isArray(payload.paths) ? payload.paths : [];
            if (paths.length === 0) return;
            try {
              const loaded = await invoke<Array<{ name: string; dataUrl: string }>>(
                "read_dropped_images",
                { paths }
              );
              if (!disposed && Array.isArray(loaded) && loaded.length > 0) {
                const compressed = await Promise.all(
                  loaded.map((item) => compressImageDataUrl(item.dataUrl, item.name))
                );
                if (!disposed) {
                  attachCompressedImages(compressed);
                }
              }
            } catch {
              // Ignore invalid or non-image drop
            }
          }
        });
        if (disposed) {
          unlisten();
        } else {
          unlistenDrop = unlisten;
        }
      } catch {
        // Fallback outside Tauri (HTML5 drag/drop handles dev browser)
      }
    };

    attachDrop();

    return () => {
      disposed = true;
      if (unlistenDrop) unlistenDrop();
    };
  }, [isAwake, pipPhase, voiceActive, pillMode, attachCompressedImages]);

  // Global Clipboard Image Paste (Ctrl+V after Win+Shift+S screenshot!) across both Compact & Expanded bars
  useEffect(() => {
    if (!isAwake || pipPhase !== "max" || voiceActive) return;
    if (pillMode !== "idle" && pillMode !== "responding") return;

    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.startsWith("image/")) {
          const f = items[i].getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImageFileList(imageFiles);
      }
    };

    window.addEventListener("paste", handleGlobalPaste);
    return () => window.removeEventListener("paste", handleGlobalPaste);
  }, [isAwake, pipPhase, voiceActive, pillMode, handleImageFileList]);

  // Close open [+] action tray cleanly on outside click
  useEffect(() => {
    if (!isPlusTrayOpen) return;
    const handleDocClick = () => {
      setIsPlusTrayOpen(false);
    };
    window.addEventListener("click", handleDocClick);
    return () => window.removeEventListener("click", handleDocClick);
  }, [isPlusTrayOpen]);

  const lastReportedHRef = useRef<number>(0);

  const isMultiTurnMode = Boolean(
    isMaxHeight || activeTurns.length > 1 || hasFollowupPending
  );
  const stagePadTop = isControlsVisible ? 56 : 28;
  const stagePadBot = isControlsVisible ? 76 + followupExtraH + (hasActiveImages ? 56 : 0) : 16;
  const stageMinH = Math.max(240, 620 - 32 - stagePadTop - stagePadBot);

  // Synchronize responding height (pure content + controls, or max 620px canvas on Turn 2+) with the native HWND pill
  useLayoutEffect(() => {
    if (browserSession) {
      return;
    }
    if (pillMode !== "responding") {
      lastReportedHRef.current = 0;
      return;
    }
    if (pipPhase !== "max") {
      return;
    }

    const measure = () => {
      if (isMultiTurnMode) {
        if (lastReportedHRef.current !== 620) {
          lastReportedHRef.current = 620;
          if (onHeightChange) {
            onHeightChange(620, 240);
          }
        }
        requestAnimationFrame(updateScrollMask);
        return;
      }

      const el = streamContainerRef.current;
      let pureContentH = 80;
      if (el && el.children.length > 0) {
        let total = 0;
        for (let i = 0; i < el.children.length; i++) {
          const child = el.children[i] as HTMLElement;
          const rect = child.getBoundingClientRect();
          const childH = Math.max(child.offsetHeight, child.scrollHeight, Math.ceil(rect.height));
          total += childH;
        }
        if (el.children.length > 1) {
          total += (el.children.length - 1) * 12;
        }
        pureContentH = Math.max(60, total);
      } else if (el) {
        pureContentH = Math.max(60, el.scrollHeight);
      }

      const headerH = activeUiTag ? 36 : 0;
      // Exact chrome clearance: pill vertical padding (32px) + unhovered stream padding (28 + 16 = 44px) + 2px buffer
      const baseH = pureContentH + headerH + 78;
      // When controls (close button at top + command bar at bottom) are visible, allocate +90px (+56px when images attached)
      const imgExtraH = hasActiveImages ? 56 : 0;
      const targetH = isControlsVisible ? baseH + 90 + imgExtraH : baseH;
      const clampedTargetH = Math.min(620, Math.max(isControlsVisible ? 180 + imgExtraH : 128, targetH));

      if (Math.abs(clampedTargetH - lastReportedHRef.current) >= 4) {
        lastReportedHRef.current = clampedTargetH;
        if (onHeightChange) {
          onHeightChange(clampedTargetH, 220);
        }
      }
      requestAnimationFrame(updateScrollMask);
    };

    measure();

    const rafId = requestAnimationFrame(measure);

    const el = streamContainerRef.current;
    let observer: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        measure();
        updateScrollMask();
      });
      observer.observe(el);
      for (let i = 0; i < el.children.length; i++) {
        observer.observe(el.children[i]);
      }
    }

    return () => {
      cancelAnimationFrame(rafId);
      if (observer) {
        observer.disconnect();
      }
    };
  }, [browserSession, pillMode, pipPhase, isMultiTurnMode, isControlsVisible, hasActiveImages, activeUiTag, followupThinkingPrompt, followupThinkingImages, activeTurns, isStreaming, agyWorkJob, proactiveTurnKind, onHeightChange, updateScrollMask]);

  const clampedSelectionIndex = Math.max(0, Math.min(selectionIndex, inputText.length));
  const cursorPrefix = inputText.slice(0, clampedSelectionIndex);
  const cursorSuffix = inputText.slice(clampedSelectionIndex);

  const measureActiveCaret = useCallback(() => {
    const isFollowup = showReplyWindow;
    const textarea = isFollowup ? followupInputRef.current : pillInputRef.current;
    const mirror = isFollowup ? followupMirrorRef.current : pillMirrorRef.current;
    const marker = isFollowup ? followupMarkerRef.current : pillMarkerRef.current;
    if (!textarea || !mirror || !marker) return;

    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    if (mirrorRect.width <= 0) return;

    const cursorH = 18;
    const markerH = markerRect.height > 2 ? markerRect.height : 22;
    const rawLeft = markerRect.left - mirrorRect.left - textarea.scrollLeft;
    const rawTop =
      markerRect.top -
      mirrorRect.top +
      (markerH - cursorH) / 2 +
      (isFollowup ? 0 : 0.5) -
      textarea.scrollTop;

    const maxLeft = Math.max(0, textarea.clientWidth - 2);
    const clampedLeft = Math.max(0, Math.min(rawLeft, maxLeft));
    const inView = rawTop + cursorH > -2 && rawTop < textarea.clientHeight + 2;

    setCaretPos((prev) => {
      if (
        Math.abs(prev.left - clampedLeft) < 0.25 &&
        Math.abs(prev.top - rawTop) < 0.25 &&
        prev.visible === inView
      ) {
        return prev;
      }
      return { left: clampedLeft, top: rawTop, visible: inView };
    });
  }, [showReplyWindow]);

  // Measure 2D caret coordinates synchronously before paint + re-check after browser auto-scroll
  useLayoutEffect(() => {
    measureActiveCaret();
    const rafId = window.requestAnimationFrame(() => measureActiveCaret());
    return () => window.cancelAnimationFrame(rafId);
  }, [
    inputText,
    clampedSelectionIndex,
    showReplyWindow,
    isMultiline,
    isInputFocused,
    pillMode,
    isAwake,
    followupExtraH,
    measureActiveCaret,
  ]);

  // Keep 2D caret synced if the textarea resizes (e.g. morphing or line expansion)
  useEffect(() => {
    const activeEl = showReplyWindow ? followupInputRef.current : pillInputRef.current;
    if (!activeEl) return;
    const ro = new ResizeObserver(() => measureActiveCaret());
    ro.observe(activeEl);
    return () => ro.disconnect();
  }, [showReplyWindow, pillMode, isControlsVisible, measureActiveCaret]);

  // Focus active input (immediate for idle Search/Ask pill; preserves hover-to-reveal in maximized mode unless a draft exists or user starts typing)
  const focusActiveInput = useCallback(
    (forceFollowup = false) => {
      if (!isAwake || voiceActive || (pipPhase !== "max" && pipPhase !== "to-max")) {
        return;
      }
      if (pillMode === "idle") {
        const el = pillInputRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          // Ignore if not yet selectable
        }
        setSelectionIndex(end);
        setHasTextSelection(false);
        window.requestAnimationFrame(() => measureActiveCaret());
        return;
      }
      if (pillMode === "responding" && (forceFollowup || inputTextRef.current.length > 0)) {
        const el = followupInputRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        setIsInputFocused(true);
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          // Ignore if not yet selectable
        }
        setSelectionIndex(end);
        setHasTextSelection(false);
        window.requestAnimationFrame(() => measureActiveCaret());
      }
    },
    [isAwake, voiceActive, pipPhase, pillMode, measureActiveCaret]
  );

  // Auto-focus input when waking or restoring from PiP so typing works immediately
  useEffect(() => {
    if (!isAwake || voiceActive || (pipPhase !== "max" && pipPhase !== "to-max")) {
      return;
    }
    const t1 = window.setTimeout(() => focusActiveInput(false), pipPhase === "to-max" ? 20 : 40);
    const t2 = window.setTimeout(() => focusActiveInput(false), pipPhase === "to-max" ? 110 : 120);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isAwake, pillMode, pipPhase, voiceActive, focusActiveInput]);

  // Re-assert DOM focus the exact millisecond WebView2 acquires native OS window focus
  useEffect(() => {
    const handleWindowFocus = () => {
      focusActiveInput(false);
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [focusActiveInput]);

  // Sync with Rust main-thread native focus handoff ("aiden-focus-input")
  const focusActiveInputRef = useRef(focusActiveInput);
  focusActiveInputRef.current = focusActiveInput;
  useEffect(() => {
    let disposed = false;
    let unlistenFocus: (() => void) | undefined;

    const setupFocusListener = async () => {
      try {
        const unlisten = await listen("aiden-focus-input", () => {
          focusActiveInputRef.current(false);
        });
        if (disposed) {
          unlisten();
        } else {
          unlistenFocus = unlisten;
        }
      } catch {
        // Fallback outside Tauri
      }
    };

    setupFocusListener();
    return () => {
      disposed = true;
      if (unlistenFocus) unlistenFocus();
    };
  }, []);

  const triggerMinimizeToPipRef = useRef<() => void>(() => {});
  const closeSearchDrawerRef = useRef<() => boolean>(() => false);

  const sleepUi = useCallback(() => {
    setDrawerForceOpen(false);
    setDrawerSelectedIndex(-1);
    setSearchResult(null);
    setIsHovered(false);
    setIsInputFocused(false);
    pillInputRef.current?.blur();
    followupInputRef.current?.blur();
    if (isAwake && onToggleSleep) {
      onToggleSleep();
    }
  }, [isAwake, onToggleSleep]);

  // Global key listener: Ctrl+M to minimize, Space to exit voice, Escape to sleep,
  // plus zero-click Type-Anywhere & Ctrl+V capture into Search/Ask or Ask Aiden
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key.toLowerCase() === "m" || e.code === "KeyM")
      ) {
        if (pillMode === "responding" && isAwake && pipPhase === "max") {
          e.preventDefault();
          triggerMinimizeToPipRef.current();
          return;
        }
      }
      if (e.key === " " || e.code === "Space") {
        if (pillMode === "responding" && voiceActive) {
          e.preventDefault();
          toggleVoiceMode(false);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (browserSession && onCloseBrowser) {
          onCloseBrowser();
        } else if (voiceActive) {
          toggleVoiceMode(false);
        } else if (closeSearchDrawerRef.current()) {
          return;
        } else {
          sleepUi();
        }
        return;
      }

      // Zero-click Type-Anywhere / Paste-Anywhere while AIDEN is awake & open
      if (
        browserSession ||
        e.defaultPrevented ||
        e.isComposing ||
        !isAwake ||
        voiceActive ||
        (pipPhase !== "max" && pipPhase !== "to-max") ||
        (pillMode !== "idle" && pillMode !== "responding")
      ) {
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active === pillInputRef.current ||
          active === followupInputRef.current ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "INPUT" ||
          active.isContentEditable)
      ) {
        return;
      }

      const targetEl = pillMode === "responding" ? followupInputRef.current : pillInputRef.current;
      if (!targetEl) return;

      // Ctrl+V / Cmd+V directly focuses input so native clipboard paste lands inside it
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v") {
        if (pillMode === "responding") {
          setIsInputFocused(true);
        }
        targetEl.focus({ preventScroll: true });
        return;
      }

      // Preserve all other modifier shortcuts (Ctrl+C to copy reply text, Ctrl+A, etc.)
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      // Backspace when a draft exists while blurred
      if (e.key === "Backspace" && inputTextRef.current.length > 0) {
        e.preventDefault();
        const nextVal = inputTextRef.current.slice(0, -1);
        inputTextRef.current = nextVal;
        targetEl.value = nextVal;
        if (pillMode === "responding") {
          setIsInputFocused(true);
        }
        targetEl.focus({ preventScroll: true });
        try {
          targetEl.setSelectionRange(nextVal.length, nextVal.length);
        } catch {
          // Ignore
        }
        setInputText(nextVal);
        setSelectionIndex(nextVal.length);
        setHasTextSelection(false);
        window.requestAnimationFrame(() => measureActiveCaret());
        return;
      }

      // Single printable character -> capture synchronously with zero dropped/reordered keystrokes
      if (e.key.length === 1) {
        // Don't hijack Space on an empty maximized reading card (user may press Space to scroll)
        if (pillMode === "responding" && inputTextRef.current.length === 0 && e.key === " ") {
          return;
        }
        e.preventDefault();
        const nextVal = inputTextRef.current + e.key;
        inputTextRef.current = nextVal;
        targetEl.value = nextVal;
        if (pillMode === "responding") {
          setIsInputFocused(true);
        }
        targetEl.focus({ preventScroll: true });
        try {
          targetEl.setSelectionRange(nextVal.length, nextVal.length);
        } catch {
          // Ignore
        }
        setInputText(nextVal);
        setSelectionIndex(nextVal.length);
        setHasTextSelection(false);
        window.requestAnimationFrame(() => measureActiveCaret());
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [browserSession, onCloseBrowser, voiceActive, pillMode, isAwake, pipPhase, sleepUi, measureActiveCaret]);

  // Reset scroll to top when a new conversation prompt is submitted so the user reads from the beginning
  useEffect(() => {
    if (userPrompt && streamContainerRef.current) {
      streamContainerRef.current.scrollTop = 0;
      updateScrollMask();
    }
  }, [userPrompt, updateScrollMask]);

  // Concurrent Staggered Turn 2+ Choreography:
  // T=0ms: Auto-scroll begins immediately alongside window expansion to open blank space below.
  // T=+110ms: After a brief beat (nearly simultaneous!), dot fades in right under the command bar,
  //           tracks live scroll position while unfolding up the right edge, and settles with an ease-out spring.
  // Phase 3: Left-aligned status tag reveals cleanly underneath the bubble.
  useLayoutEffect(() => {
    const cancelAll = () => {
      if (scrollAnimRafRef.current !== null) {
        cancelAnimationFrame(scrollAnimRafRef.current);
        scrollAnimRafRef.current = null;
      }
      bubbleAnimRafIdsRef.current.forEach((id) => cancelAnimationFrame(id));
      bubbleAnimRafIdsRef.current = [];
    };

    if (pillMode !== "responding" || !hasFollowupPending || !streamContainerRef.current) {
      cancelAll();
      return;
    }

    const cancelled = { current: false };
    let initRaf1: number | null = null;
    let initRaf2: number | null = null;
    let launchTimerId: number | null = null;

    initRaf1 = requestAnimationFrame(() => {
      if (cancelled.current) return;
      initRaf2 = requestAnimationFrame(() => {
        if (cancelled.current) return;
        const container = streamContainerRef.current;
        if (!container) return;
        const pendingEl = container.querySelector(".siri-turn-item.pending-turn") as HTMLElement | null;
        if (!pendingEl) return;

        const padTop = container.parentElement?.classList.contains("controls-visible") ? 56 : 28;
        const targetTop = Math.max(0, pendingEl.offsetTop - padTop);

        animateStreamScroll(container, targetTop, 420, scrollAnimRafRef, cancelled, updateScrollMask);

        launchTimerId = window.setTimeout(() => {
          launchTimerId = null;
          if (cancelled.current) return;
          const bubble = pendingBubbleRef.current;
          const wrapEl = pendingWrapRef.current;
          if (!bubble || !bubble.isConnected || !wrapEl || !wrapEl.isConnected) {
            if (pendingStatusRef.current) {
              pendingStatusRef.current.classList.remove("status-awaiting");
              pendingStatusRef.current.classList.add("status-reveal");
            }
            return;
          }
          animateFollowupBubbleFlight({
            wrapEl,
            bubble,
            labelEl: pendingLabelRef.current,
            statusEl: pendingStatusRef.current,
            barEl: followupBarRef.current,
            streamEl: container,
            rafIdsRef: bubbleAnimRafIdsRef,
            cancelled,
          });
        }, 110);
      });
    });

    return () => {
      cancelled.current = true;
      if (initRaf1 !== null) cancelAnimationFrame(initRaf1);
      if (initRaf2 !== null) cancelAnimationFrame(initRaf2);
      if (launchTimerId !== null) window.clearTimeout(launchTimerId);
      cancelAll();
    };
  }, [pillMode, hasFollowupPending, followupThinkingPrompt, activeTurns.length, updateScrollMask]);

  // Synchronize SVG #aiden-stream-lens-blur cutout shapes frame-by-frame with the floating glass controls'
  // real live bounding boxes and opacities (zero React re-renders during transitions)
  const syncLensMaskToDom = useCallback(() => {
    const streamEl = streamContainerRef.current;
    const filterEl = lensFilterRef.current;
    const imgEl = lensMaskImgRef.current;
    if (!streamEl || !filterEl || !imgEl) return;

    const elRect = streamEl.getBoundingClientRect();
    const w = streamEl.clientWidth || 430;
    const h = streamEl.clientHeight || 360;
    if (w <= 0 || h <= 0 || elRect.width <= 0 || elRect.height <= 0) return;

    const sx = w / elRect.width;
    const sy = h / elRect.height;

    const shapeFor = (
      node: HTMLElement | null,
      rxBase: number | "circle" | "pill",
      opacityScale = 1
    ): string => {
      if (!node || opacityScale <= 0.01) return "";
      const op = parseFloat(window.getComputedStyle(node).opacity || "0") * opacityScale;
      if (!Number.isFinite(op) || op <= 0.01) return "";
      const r = node.getBoundingClientRect();
      const x = (r.left - elRect.left) * sx;
      const y = (r.top - elRect.top) * sy;
      const bw = r.width * sx;
      const bh = r.height * sy;
      if (bw <= 0 || bh <= 0) return "";
      const rx =
        rxBase === "circle"
          ? bw / 2
          : rxBase === "pill"
          ? Math.min(bw / 2, bh / 2)
          : Math.min(rxBase, bw / 2, bh / 2);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${rx.toFixed(1)}" fill="white" fill-opacity="${Math.min(1, op).toFixed(3)}"/>`;
    };

    const rawScrollAnchorOp = scrollBottomAnchorRef.current
      ? parseFloat(window.getComputedStyle(scrollBottomAnchorRef.current).opacity || "1")
      : 1;
    const scrollAnchorOp = Number.isFinite(rawScrollAnchorOp) ? rawScrollAnchorOp : 1;

    const shapes =
      shapeFor(sleepBtnRef.current, "circle") +
      shapeFor(closeBtnRef.current, "circle") +
      shapeFor(plusBtnRef.current, isPlusTrayOpen ? 22 : 24) +
      shapeFor(capsuleRef.current, hasActiveImages ? 20 : 24) +
      shapeFor(micBtnRef.current, "circle") +
      shapeFor(scrollBottomBtnRef.current, "pill", scrollAnchorOp);

    const sig = `${w}x${h}:${shapes}`;
    if (sig === lastLensSigRef.current) return;
    lastLensSigRef.current = sig;

    const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shapes}</svg>`;
    const maskUri = `data:image/svg+xml;utf8,${encodeURIComponent(maskSvg)}`;

    filterEl.setAttribute("width", String(w));
    filterEl.setAttribute("height", String(h));
    imgEl.setAttribute("width", String(w));
    imgEl.setAttribute("height", String(h));
    imgEl.setAttribute("href", maskUri);
  }, [hasActiveImages, isPlusTrayOpen]);

  const runLensSyncFor = useCallback((durationMs: number) => {
    const deadline = performance.now() + durationMs;
    if (deadline > lensSyncUntilRef.current) {
      lensSyncUntilRef.current = deadline;
    }
    syncLensMaskToDom();
    if (lensRafIdRef.current !== null) return;

    const tick = (now: number) => {
      syncLensMaskToDom();
      if (now < lensSyncUntilRef.current) {
        lensRafIdRef.current = requestAnimationFrame(tick);
      } else {
        lensRafIdRef.current = null;
      }
    };
    lensRafIdRef.current = requestAnimationFrame(tick);
  }, [syncLensMaskToDom]);

  const stopLensSync = useCallback(() => {
    lensSyncUntilRef.current = 0;
    if (lensRafIdRef.current !== null) {
      cancelAnimationFrame(lensRafIdRef.current);
      lensRafIdRef.current = null;
    }
    if (lensHideTimerRef.current !== null) {
      window.clearTimeout(lensHideTimerRef.current);
      lensHideTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopLensSync(), [stopLensSync]);

  // Drive SVG lens filter activation & frame-synced motion when controls or the ↓ Latest pill show/hide
  const wasLensControlsVisibleRef = useRef(false);
  const isScrollBottomRendered = scrollBottomState !== "hidden";
  useLayoutEffect(() => {
    if (!showReplyWindow || voiceActive || pipPhase !== "max") {
      wasLensControlsVisibleRef.current = false;
      stopLensSync();
      setIsLensBlurActive(false);
      return;
    }

    const needsLensBlur = isControlsVisible || isScrollBottomRendered;

    if (needsLensBlur) {
      wasLensControlsVisibleRef.current = true;
      if (lensHideTimerRef.current !== null) {
        window.clearTimeout(lensHideTimerRef.current);
        lensHideTimerRef.current = null;
      }
      setIsLensBlurActive(true);
      runLensSyncFor(620);
    } else if (wasLensControlsVisibleRef.current) {
      wasLensControlsVisibleRef.current = false;
      setIsLensBlurActive(true);
      runLensSyncFor(260);
      if (lensHideTimerRef.current !== null) {
        window.clearTimeout(lensHideTimerRef.current);
      }
      lensHideTimerRef.current = window.setTimeout(() => {
        lensHideTimerRef.current = null;
        setIsLensBlurActive(false);
      }, 260);
    }
  }, [showReplyWindow, voiceActive, pipPhase, isControlsVisible, isScrollBottomRendered, scrollBottomState, runLensSyncFor, stopLensSync]);

  // Keep SVG lens filter cutouts tracking smooth height morph when expanding to 620px on Turn 2+
  useLayoutEffect(() => {
    if (showReplyWindow && (isControlsVisible || isScrollBottomRendered) && !voiceActive && isMultiTurnMode) {
      runLensSyncFor(320);
    }
  }, [isMultiTurnMode, showReplyWindow, isControlsVisible, isScrollBottomRendered, voiceActive, runLensSyncFor]);

  // Track organic [+] morph into liquid-glass tray, Ask Aiden stretch, attached-image expansion, and ↓ Latest ride at 60fps
  useLayoutEffect(() => {
    if (showReplyWindow && (isControlsVisible || isScrollBottomRendered) && !voiceActive && pipPhase === "max") {
      runLensSyncFor(560);
    }
  }, [isPlusTrayOpen, hasActiveImages, deepReason, followupExtraH, showReplyWindow, isControlsVisible, isScrollBottomRendered, voiceActive, pipPhase, runLensSyncFor]);

  // Keep stream top/bottom scroll-fade mask & SVG lens filter synchronized with container resizes and scrolling
  useLayoutEffect(() => {
    const el = streamContainerRef.current;
    if (!el) return;

    updateScrollMask();
    syncLensMaskToDom();

    const onScroll = () => {
      updateScrollMask();
    };

    el.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      updateScrollMask();
      syncLensMaskToDom();
    });
    resizeObserver.observe(el, { box: "border-box" });

    return () => {
      el.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [showReplyWindow, pipPhase, activeTurns, followupThinkingPrompt, responseMessage, userPrompt, isControlsVisible, activeUiTag, followupExtraH, updateScrollMask, syncLensMaskToDom]);

  const updateSelection = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setSelectionIndex(start);
    setHasTextSelection(end !== start);
  }, []);

  const resetTextarea = () => {
    setIsMultiline(false);
    setFollowupExtraH(0);
    lastTextareaIdleHRef.current = 60;
    if (pillInputRef.current) {
      pillInputRef.current.style.height = "";
      pillInputRef.current.scrollTop = 0;
    }
    if (followupInputRef.current) {
      followupInputRef.current.style.height = "";
      followupInputRef.current.scrollTop = 0;
    }
    if (
      !shouldShowSearchDrawer &&
      !hasActiveImages &&
      lastIdleReportedHRef.current !== 60
    ) {
      lastIdleReportedHRef.current = 60;
      if (pillMode === "idle" && !voiceActive && onHeightChange) {
        onHeightChange(60, 160);
      }
    }
  };

  const adjustTextareaHeight = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const val = el.value || "";
    if (val.length === 0) {
      resetTextarea();
      return;
    }

    el.style.height = "auto";
    const minH = showReplyWindow ? 22 : 24;
    // Idle pill: ~7 lines (162px); Expanded follow-up capsule: strictly 6 lines (132px) before internal scrolling
    const maxH = showReplyWindow ? 132 : 162;
    const scrollH = el.scrollHeight;
    const isMulti = scrollH > (minH + 6) || val.includes("\n");
    setIsMultiline(isMulti);

    const targetH = Math.min(Math.max(scrollH, minH), maxH);
    el.style.height = `${targetH}px`;
    if (scrollH <= maxH + 1) {
      el.scrollTop = 0;
    }

    if (showReplyWindow) {
      const nextExtra = Math.max(0, Math.min(110, Math.round(targetH - minH)));
      setFollowupExtraH(nextExtra);
      requestAnimationFrame(updateScrollMask);
    } else {
      setFollowupExtraH(0);
      const nextPillH = isMulti ? Math.min(198, Math.max(60, Math.ceil(targetH + 34))) : 60;
      lastTextareaIdleHRef.current = nextPillH;
      const totalIdleH = nextPillH + (hasActiveImages ? 60 : 0);
      if (!shouldShowSearchDrawer && pillMode === "idle" && !voiceActive && onHeightChange) {
        if (Math.abs(totalIdleH - lastIdleReportedHRef.current) >= 2) {
          lastIdleReportedHRef.current = totalIdleH;
          onHeightChange(totalIdleH, 160);
        }
      }
    }
  };

  // Reset input expansion and sizing whenever a turn starts, input clears, speech arrives, or awake state toggles
  useEffect(() => {
    if (!inputText || inputText.length === 0) {
      resetTextarea();
    } else {
      const activeEl = showReplyWindow ? followupInputRef.current : pillInputRef.current;
      if (activeEl) {
        adjustTextareaHeight(activeEl);
      }
    }
  }, [inputText, showReplyWindow, isAwake, userPrompt, pillMode, voiceActive]);

  // =========================================================================
  // CONJOINED RAYCAST-STYLE SEARCH TRAY (4-char threshold + ↓ force-open)
  // =========================================================================
  const isSearchEligible = Boolean(
    isAwake &&
      pipPhase === "max" &&
      pillMode === "idle" &&
      !voiceActive &&
      !isSubmitting &&
      !isMultiline &&
      !hasActiveImages &&
      !inputText.includes("\n")
  );
  const trimmedSearchQuery = inputText.trim();
  const drawerItems: SearchItem[] = searchResult
    ? searchResult.mode === "recents"
      ? searchResult.recents
      : [...searchResult.apps, ...(searchResult.bookmarks ?? []), ...searchResult.files]
    : [];
  const searchMatchesCurrentQuery = Boolean(
    searchResult &&
      ((trimmedSearchQuery.length === 0 && searchResult.mode === "recents") ||
        (trimmedSearchQuery.length > 0 &&
          searchResult.mode === "search" &&
          searchResult.query.toLowerCase() === trimmedSearchQuery.toLowerCase()))
  );
  const shouldShowSearchDrawer = Boolean(
    isSearchEligible &&
      searchMatchesCurrentQuery &&
      (trimmedSearchQuery.length === 0
        ? drawerForceOpen
        : trimmedSearchQuery.length < SEARCH_AUTO_THRESHOLD
        ? drawerForceOpen && drawerItems.length > 0
        : drawerItems.length > 0)
  );

  const runUnifiedSearch = useCallback(
    async (queryStr: string, includeFiles: boolean, autoSelectFirst: boolean) => {
      const gen = ++searchReqGenRef.current;
      try {
        const res = await invoke<UnifiedSearchResponse>("search_unified", {
          query: queryStr,
          includeFiles,
        });
        if (gen !== searchReqGenRef.current) return;
        setSearchResult(res);
        const total =
          res.mode === "recents"
            ? res.recents.length
            : res.apps.length + (res.bookmarks?.length ?? 0) + res.files.length;
        if (autoSelectFirst && total > 0) {
          setDrawerSelectedIndex(0);
        } else {
          setDrawerSelectedIndex((prev) => (prev >= total ? total - 1 : prev));
        }
      } catch {
        // Ignore outside Tauri
      }
    },
    []
  );

  // Trigger unified single-pass live search whenever query passes 4-char threshold or drawer is force-opened
  useEffect(() => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }

    if (!isSearchEligible) {
      setDrawerForceOpen(false);
      setDrawerSelectedIndex(-1);
      setSearchResult(null);
      return;
    }

    const q = trimmedSearchQuery;
    if (q.length === 0) {
      if (drawerForceOpen) {
        runUnifiedSearch("", false, false);
      } else {
        setSearchResult(null);
        setDrawerSelectedIndex(-1);
      }
      return;
    }

    if (q.length < SEARCH_AUTO_THRESHOLD && !drawerForceOpen) {
      setSearchResult(null);
      setDrawerSelectedIndex(-1);
      return;
    }

    // Single-pass unified search (Apps + Files arrive together — zero split pop-in):
    // Immediate when opening; 16ms frame-coalesced while continuing to type.
    const wantFiles = q.length >= 2;
    if (!drawerVisiblePrevRef.current) {
      runUnifiedSearch(q, wantFiles, false);
    } else {
      searchDebounceRef.current = window.setTimeout(() => {
        searchDebounceRef.current = null;
        runUnifiedSearch(q, wantFiles, false);
      }, 16);
    }

    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
    };
  }, [isSearchEligible, trimmedSearchQuery, drawerForceOpen, runUnifiedSearch]);

  // Morph the single conjoined AIDEN HWND height seamlessly when the app tray or image strip opens/closes
  useEffect(() => {
    drawerVisiblePrevRef.current = shouldShowSearchDrawer;
    if (browserSession || pillMode !== "idle" || voiceActive || !onHeightChange) return;
    const baseBarH = isMultiline ? Math.max(60, lastTextareaIdleHRef.current) : 60;
    const imgStripH = hasActiveImages ? 60 : 0;
    const desiredH =
      shouldShowSearchDrawer && searchResult
        ? 60 + 1 + computeSearchDrawerHeight(searchResult)
        : baseBarH + imgStripH;
    if (Math.abs(desiredH - lastIdleReportedHRef.current) >= 2) {
      lastIdleReportedHRef.current = desiredH;
      onHeightChange(desiredH, 210);
    }
  }, [
    pillMode,
    voiceActive,
    isMultiline,
    hasActiveImages,
    shouldShowSearchDrawer,
    searchResult,
    onHeightChange,
    browserSession,
  ]);

  const triggerLaunchSearchItem = useCallback(
    (chosen: SearchItem, reveal: boolean, runAsAdmin: boolean) => {
      const slimItem = { ...chosen, iconDataUrl: null };
      setInputText("");
      inputTextRef.current = "";
      setDrawerForceOpen(false);
      setDrawerSelectedIndex(-1);
      setSearchResult(null);
      resetTextarea();
      sleepUi();
      invoke("launch_search_item", {
        item: slimItem,
        revealInExplorer: reveal,
        runAsAdmin,
      }).catch(() => {});
    },
    [sleepUi]
  );

  closeSearchDrawerRef.current = () => {
    if (isPlusTrayOpen) {
      setIsPlusTrayOpen(false);
      return true;
    }
    if (!shouldShowSearchDrawer) return false;
    setDrawerForceOpen(false);
    setDrawerSelectedIndex(-1);
    setSearchResult(null);
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Down Arrow: force-open drawer (empty -> Recents, <4 chars -> short query) or step through rows
    if (e.key === "ArrowDown" && isSearchEligible) {
      const atEnd = !isMultiline || (e.currentTarget.selectionStart ?? 0) >= inputText.length;
      if (atEnd) {
        e.preventDefault();
        if (!shouldShowSearchDrawer) {
          setDrawerForceOpen(true);
          runUnifiedSearch(trimmedSearchQuery, trimmedSearchQuery.length >= 2, true);
        } else if (drawerItems.length > 0) {
          setDrawerSelectedIndex((prev) => (prev < drawerItems.length - 1 ? prev + 1 : 0));
        }
        return;
      }
    }

    // Up Arrow: navigate up rows -> back to "Search or Ask" -> close force-opened drawer
    if (e.key === "ArrowUp" && shouldShowSearchDrawer) {
      e.preventDefault();
      if (drawerSelectedIndex > 0) {
        setDrawerSelectedIndex((prev) => prev - 1);
      } else if (drawerSelectedIndex === 0) {
        setDrawerSelectedIndex(-1);
      } else if (drawerSelectedIndex === -1 && drawerForceOpen) {
        setDrawerForceOpen(false);
      }
      return;
    }

    // Enter: launch/admin-launch highlighted tray item, insert newline + kill tray on Shift+Enter in command bar, or send to AIDEN
    if (e.key === "Enter") {
      if (shouldShowSearchDrawer && drawerSelectedIndex >= 0 && drawerItems[drawerSelectedIndex]) {
        e.preventDefault();
        const chosen = drawerItems[drawerSelectedIndex];
        const reveal = e.ctrlKey || e.metaKey;
        const runAsAdmin = e.shiftKey && !reveal;
        triggerLaunchSearchItem(chosen, reveal, runAsAdmin);
        return;
      }
      if (e.shiftKey) {
        // Shift+Enter on "Search or Ask" command bar: insert native newline & immediately kill app tray!
        setDrawerForceOpen(false);
        setDrawerSelectedIndex(-1);
        setSearchResult(null);
        return;
      }
      e.preventDefault();
      setDrawerForceOpen(false);
      setDrawerSelectedIndex(-1);
      setSearchResult(null);
      handleSend();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (isPlusTrayOpen) {
        setIsPlusTrayOpen(false);
      } else if (shouldShowSearchDrawer) {
        setDrawerForceOpen(false);
        setDrawerSelectedIndex(-1);
        setSearchResult(null);
      } else {
        sleepUi();
      }
    }
  };

  const handleSend = () => {
    const trimmed = inputText.trim();
    const readyImages = attachedImagesRef.current
      .filter((im) => !im.removing)
      .map(({ name, dataUrl }) => ({ name, dataUrl }));
    if ((!trimmed && readyImages.length === 0) || isSubmitting) return;
    // Smart Maximized Interruption Guard: while AIDEN is announcing a finished background task,
    // hold submission without erasing or blurring the user's draft text.
    if (isProactiveAnnouncementActive) {
      setAnnouncementBlockPulse(true);
      if (announcementBlockTimerRef.current !== null) {
        window.clearTimeout(announcementBlockTimerRef.current);
      }
      announcementBlockTimerRef.current = window.setTimeout(() => {
        announcementBlockTimerRef.current = null;
        setAnnouncementBlockPulse(false);
      }, 1150);
      return;
    }
    setDrawerForceOpen(false);
    setDrawerSelectedIndex(-1);
    setSearchResult(null);
    setIsPlusTrayOpen(false);
    setAttachedImages([]);
    setIsSubmitting(true);
    if (onSendMessage) {
      onSendMessage(trimmed, showReplyWindow, {
        images: readyImages.length > 0 ? readyImages : undefined,
        reasoningEffort: deepReason ? "high" : "none",
      });
    }
    setInputText("");
    setSelectionIndex(0);
    setHasTextSelection(false);
    setCaretPos({ left: 0, top: 2, visible: true });
    resetTextarea();
    followupInputRef.current?.blur();
    setIsInputFocused(false);
    window.setTimeout(() => {
      setIsSubmitting(false);
    }, 450);
  };

  const handleA2UIPrefill = useCallback((prefillText: string) => {
    setInputText(prefillText);
    inputTextRef.current = prefillText;
    setIsInputFocused(true);
    setIsHovered(true);
    window.requestAnimationFrame(() => {
      const el = followupInputRef.current || pillInputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      const end = prefillText.length;
      try {
        el.setSelectionRange(end, end);
      } catch {
        // Ignore if not yet selectable
      }
      setSelectionIndex(end);
      setHasTextSelection(false);
      adjustTextareaHeight(el);
      measureActiveCaret();
    });
  }, [measureActiveCaret]);

  useEffect(() => {
    return () => {
      if (announcementBlockTimerRef.current !== null) {
        window.clearTimeout(announcementBlockTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (pillMode !== "responding" || pipPhase !== "max" || voiceActive) {
      hideScrollBottomPill(true);
    }
  }, [pillMode, pipPhase, voiceActive, hideScrollBottomPill]);

  // Auto-scroll smoothly ONLY when a proactive system turn (e.g. Antigravity completion)
  // starts or lands in multi-turn chat — never hijack scroll on normal user turns.
  const prevTurnCountForProactiveRef = useRef<number>(activeTurns.length);
  useEffect(() => {
    const prevCount = prevTurnCountForProactiveRef.current;
    prevTurnCountForProactiveRef.current = activeTurns.length;
    if (pillMode !== "responding" || pipPhase !== "max" || !streamContainerRef.current) return;
    const latestTurn = activeTurns[activeTurns.length - 1];
    const isNewProactiveTurn =
      activeTurns.length > prevCount && Boolean(latestTurn?.isProactive);
    if (isProactiveThinkingInStream || isNewProactiveTurn) {
      const container = streamContainerRef.current;
      window.requestAnimationFrame(() => {
        if (!streamContainerRef.current) return;
        const padTop = container.parentElement?.classList.contains("controls-visible") ? 56 : 28;
        const turnEls = container.querySelectorAll(".siri-turn-item");
        const targetEl = turnEls.length > 0 ? (turnEls[turnEls.length - 1] as HTMLElement) : null;
        const targetTop = isProactiveThinkingInStream
          ? Math.max(0, container.scrollHeight - container.clientHeight)
          : targetEl
          ? Math.max(0, targetEl.offsetTop - padTop)
          : 0;
        if (targetTop > 2) {
          container.scrollTo({ top: targetTop, behavior: "smooth" });
          window.requestAnimationFrame(updateScrollMask);
        }
      });
    }
  }, [pillMode, pipPhase, isProactiveThinkingInStream, activeTurns, updateScrollMask]);

  const formatStatusTag = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const lower = trimmed.toLowerCase();
    const formatted = lower.charAt(0).toUpperCase() + lower.slice(1);
    return formatted
      .replace(/\bgmail\b/gi, "Gmail")
      .replace(/\byoutube\b/gi, "YouTube")
      .replace(/\bspotify\b/gi, "Spotify")
      .replace(/\bgoogle calendar\b/gi, "Google Calendar")
      .replace(/\bgps\b/gi, "GPS")
      .replace(/\bobsidian\b/gi, "Obsidian")
      .replace(/\bnotion\b/gi, "Notion")
      .replace(/\bantigravity\b/gi, "Antigravity");
  };

  const triggerMinimizeToPip = useCallback(() => {
    if (!onMinimizeToPip || !isAwake || pillMode !== "responding") return;
    if (pipPhase === "pip" || pipPhase === "to-pip") return;
    const stillControls = isInputFocused || inputText.length > 0 || hasActiveImages;
    const fallbackH = lastReportedHRef.current || 280;
    const restoreH = isMultiTurnMode
      ? 620
      : Math.min(
          620,
          Math.max(
            stillControls ? 180 : 128,
            stillControls || !isControlsVisible ? fallbackH : fallbackH - 90
          )
        );
    setIsPlusTrayOpen(false);
    setIsHovered(false);
    setIsInputFocused(false);
    followupInputRef.current?.blur();
    onMinimizeToPip(restoreH);
  }, [
    onMinimizeToPip,
    isAwake,
    pillMode,
    pipPhase,
    isInputFocused,
    inputText.length,
    hasActiveImages,
    isMultiTurnMode,
    isControlsVisible,
  ]);

  triggerMinimizeToPipRef.current = triggerMinimizeToPip;

  // Native Left-Win minimize handler: strictly Awake <-> Minimize (NEVER clears an active chat or draft)
  const handleWinKeyMinimize = useCallback(() => {
    if (!isAwake || pipPhase === "pip" || pipPhase === "to-pip") return;

    if (pillMode === "responding") {
      triggerMinimizeToPip();
      return;
    }

    // Preserve active thinking state or a half-typed idle draft / attached images in PiP rather than clearing
    if (pillMode === "thinking" || inputText.length > 0 || hasActiveImages) {
      const restoreH =
        pillMode === "thinking"
          ? 60
          : Math.max(60, lastIdleReportedHRef.current || 60);
      setIsPlusTrayOpen(false);
      setIsHovered(false);
      setIsInputFocused(false);
      pillInputRef.current?.blur();
      followupInputRef.current?.blur();
      if (onMinimizeToPip) {
        onMinimizeToPip(restoreH);
      }
      return;
    }

    // Clean empty Search/Ask pill (no chat, no draft): morph gently to the 68x68 asleep cube
    if (voiceActive) {
      toggleVoiceMode(false);
    }
    sleepUi();
  }, [
    isAwake,
    pipPhase,
    pillMode,
    inputText.length,
    hasActiveImages,
    voiceActive,
    triggerMinimizeToPip,
    onMinimizeToPip,
    sleepUi,
  ]);

  useEffect(() => {
    if (!winMinimizeRef) return;
    winMinimizeRef.current = handleWinKeyMinimize;
    return () => {
      winMinimizeRef.current = null;
    };
  }, [winMinimizeRef, handleWinKeyMinimize]);

  return (
    <div className="chat-pill-anchor">
      {/* Colourless Clear Glass Button-Lens Filter:
          Erases sharp text inside the 4 button shapes and replaces it with pure colourless blurred text */}
      <svg
        width="0"
        height="0"
        style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
        aria-hidden="true"
      >
        <defs>
          <filter
            ref={lensFilterRef}
            id="aiden-stream-lens-blur"
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={430}
            height={360}
            colorInterpolationFilters="sRGB"
          >
            {/* 1. Live pixel mask of the 4 controls ([Minimize], [+], [Ask Aiden], [Mic]) updated on rAF */}
            <feImage
              ref={lensMaskImgRef}
              href="data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22430%22%20height%3D%22360%22%3E%3C%2Fsvg%3E"
              x="0"
              y="0"
              width={430}
              height={360}
              preserveAspectRatio="none"
              result="buttonMask"
            />

            {/* 2. Refract + heavily blur the stream text/entities on its native 100% transparent background */}
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.05"
              numOctaves="2"
              seed="7"
              result="glassWave"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="glassWave"
              scale="18"
              xChannelSelector="R"
              yChannelSelector="G"
              result="refracted"
            />
            <feGaussianBlur in="refracted" stdDeviation="8" result="blurredRaw" />

            {/* Soften blurred text opacity slightly so "Ask Aiden" and button icons pop crisply */}
            <feComponentTransfer in="blurredRaw" result="blurredSoft">
              <feFuncA type="linear" slope="0.55" intercept="0" />
            </feComponentTransfer>

            {/* 3. Keep blurred text ONLY inside the 4 button shapes */}
            <feComposite
              in="blurredSoft"
              in2="buttonMask"
              operator="in"
              result="blurredInButtons"
            />

            {/* 4. Keep sharp text ONLY outside the 4 button shapes */}
            <feComposite
              in="SourceGraphic"
              in2="buttonMask"
              operator="out"
              result="sharpOutsideButtons"
            />

            {/* 5. Merge sharp outside text + colourless blurred inside-button text */}
            <feMerge>
              <feMergeNode in="sharpOutsideButtons" />
              <feMergeNode in="blurredInButtons" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <div
        ref={contentRef}
        className={`chat-pill-wrapper ${isBackendOnline && (isAwake || pipPhase !== "max") ? "awake" : ""} ${
          wakePhase === "waking" ? "waking-bloom" : wakePhase === "hiding" ? "hiding-bloom" : ""
        }`}
      >
        <div
          className={`siri-unified-pill siri-glass mode-${pillMode} ${
            effectiveExitingVoice && pillMode === "idle" ? "exiting-voice" : ""
          } ${
            pillMode === "responding" && voiceActive ? "expanded-voice-active" : ""
          } ${
            isExpandedVoiceReturning ? "expanded-voice-returning" : ""
          } ${
            isExpandedVoiceCascading ? "expanded-voice-cascading" : ""
          } ${
            isMaxHeight ? "max-height" : ""
          } ${
            isControlsVisible ? "controls-visible" : ""
          } ${
            isLensBlurActive ? "lens-blur-active" : ""
          } ${
            isHovered || isInputFocused || inputText.length > 0 || isPlusTrayOpen || hasActiveImages
              ? "hover-active"
              : ""
          } ${isMultiline && pillMode === "idle" ? "multiline" : ""} ${
            browserSession ? "browser-open" : ""
          } ${
            shouldShowSearchDrawer && pillMode === "idle"
              ? "search-tray-open"
              : ""
          } ${hasActiveImages && pillMode === "idle" ? "idle-has-images" : ""} ${
            isDragOver && pipPhase === "max" ? "is-drag-over" : ""
          } ${
            isDarkMode ? "dark-mode" : "light-mode"
          } ${pipPhase === "pip" ? "is-pip" : ""} ${
            pipPhase === "to-pip" ? "is-morphing-to-pip" : ""
          } ${pipPhase === "to-max" ? "is-morphing-to-max" : ""} ${
            pipPhase === "pip" && isPipDragging ? "is-dragging" : ""
          } ${pipPhase === "pip" && isPipDimmed ? "is-dimmed" : ""} ${
            pipPhase === "pip" && isAwake ? "pip-paused" : ""
          } ${pipPhase === "pip" && isStreaming ? "pip-streaming" : ""} ${
            pipPhase === "pip" && pipRimTone === "work_green"
              ? "pip-rim-work-green"
              : pipPhase === "pip" && pipRimTone === "green"
              ? "pip-rim-green"
              : pipPhase === "pip" && pipRimTone === "red"
              ? "pip-rim-red"
              : pipPhase === "pip" && pipRimTone === "amber"
              ? "pip-rim-amber"
              : pipPhase === "pip" && pipRimTone === "music"
              ? "pip-rim-music"
              : ""
          }`}
          onTransitionRun={(e) => {
            if (!showReplyWindow || voiceActive || pipPhase !== "max") return;
            const target = e.target as HTMLElement | null;
            if (
              target &&
              (target.classList.contains("siri-floating-close-btn") ||
                target.classList.contains("siri-command-glass-btn") ||
                target.classList.contains("siri-plus-morph-surface") ||
                target.classList.contains("plus-slot-spacer") ||
                target.classList.contains("siri-command-capsule") ||
                target.classList.contains("siri-unified-stream"))
            ) {
              runLensSyncFor(520);
            }
          }}
          onMouseEnter={() => {
            if (pipPhase !== "max") return;
            if (Date.now() - respondingMountedAtRef.current >= 100) {
              setIsHovered(true);
            }
          }}
          onMouseMove={() => {
            if (pipPhase !== "max") return;
            if (Date.now() - respondingMountedAtRef.current >= 100) {
              if (!isHovered) setIsHovered(true);
            }
          }}
          onMouseLeave={() => setIsHovered(false)}
          onDragEnter={(e) => {
            if (pipPhase !== "max" || voiceActive || (pillMode !== "idle" && pillMode !== "responding")) return;
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
              dragDepthRef.current += 1;
              setIsDragOver(true);
            }
          }}
          onDragOver={(e) => {
            if (pipPhase !== "max" || voiceActive || (pillMode !== "idle" && pillMode !== "responding")) return;
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
            }
          }}
          onDragLeave={() => {
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
              setIsDragOver(false);
            }
          }}
          onDrop={(e) => {
            if (pipPhase !== "max" || voiceActive || (pillMode !== "idle" && pillMode !== "responding")) return;
            e.preventDefault();
            dragDepthRef.current = 0;
            setIsDragOver(false);
            if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
              handleImageFileList(e.dataTransfer.files);
            }
          }}
        >
          {/* Hidden native file picker for Add image */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            multiple
            className="siri-hidden-file-input"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleImageFileList(e.target.files);
              }
              e.target.value = "";
            }}
          />

          {/* Translucent Glass Drop-Zone Halo */}
          {pipPhase === "max" && (pillMode === "idle" || pillMode === "responding") && (
            <div className="siri-drop-overlay" aria-hidden="true">
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              <span className="siri-drop-overlay-label">Drop image to attach</span>
            </div>
          )}
          {pipPhase !== "max" && onMaximizeFromPip && (
            <PipSquareEyes
              active={pipPhase === "pip"}
              isAwake={isAwake}
              isStreaming={isStreaming}
              isDarkMode={isDarkMode}
              isAntigravityWorking={isAgyRunning}
              antigravityDoneSeq={agyDoneSeq}
              antigravityFailedSeq={agyFailedSeq}
              onMaximize={onMaximizeFromPip}
              onDragVisualChange={handleDragVisualChange}
              onRimToneChange={setPipRimTone}
            />
          )}
          {/* 0. INBUILT AIDEN BROWSER (Single-View 960x600 Liquid-Glass Shell) */}
          {pipPhase === "max" && browserSession && (
            <div className="aiden-browser-shell">
              <div className="aiden-browser-topbar" data-tauri-drag-region>
                <div className="aiden-browser-brand" data-tauri-drag-region>
                  {/* Clean monochrome globe icon (no boxed blue emoji look) */}
                  <svg
                    className="aiden-browser-globe-icon"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M2 12h20" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  <span className="aiden-browser-title" data-tauri-drag-region>
                    Aiden Browser
                  </span>
                </div>

                <div className="aiden-browser-nav-cluster">
                  <button
                    type="button"
                    className="aiden-browser-icon-btn"
                    title="Back"
                    aria-label="Back"
                    onClick={() => invoke("browser_navigate_action", { action: "back" }).catch(() => {})}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="aiden-browser-icon-btn"
                    title="Forward"
                    aria-label="Forward"
                    onClick={() => invoke("browser_navigate_action", { action: "forward" }).catch(() => {})}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="aiden-browser-icon-btn"
                    title="Reload page"
                    aria-label="Reload page"
                    onClick={() => invoke("browser_navigate_action", { action: "reload" }).catch(() => {})}
                  >
                    <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <polyline points="21 3 21 9 15 9" />
                    </svg>
                  </button>
                </div>

                <div className="aiden-browser-url-pill" title={browserSession.url}>
                  <svg
                    className="aiden-browser-lock-icon"
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  <span className="aiden-browser-url-text">
                    {browserSession.url.replace(/^https?:\/\//i, "")}
                  </span>
                </div>

                <div className="aiden-browser-right-actions">
                  <button
                    type="button"
                    className="aiden-browser-icon-btn"
                    title="Open in external browser"
                    aria-label="Open in external browser"
                    onClick={() => openInAidenBrowser(browserSession.url, true)}
                  >
                    <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="aiden-browser-return-btn"
                    title="Close browser & return to chat"
                    onClick={() => onCloseBrowser?.()}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M19 12H5" />
                      <path d="M12 19l-7-7 7-7" />
                    </svg>
                    <span>Return to chat</span>
                  </button>
                </div>

                {browserSession.loading && (
                  <div className="aiden-browser-loading-bar" aria-hidden="true" />
                )}
              </div>

              <div className="aiden-browser-viewport-frame">
                <div className="aiden-browser-aurora-curtain" aria-hidden={!browserSession.loading}>
                  <div className="aiden-browser-aurora-blob blob-cyan" />
                  <div className="aiden-browser-aurora-blob blob-violet" />
                  <div className="aiden-browser-aurora-blob blob-white" />
                  <div className="aiden-browser-constellation" aria-hidden="true">
                    <span /><span /><span /><span /><span /><span />
                  </div>
                  <div className="aiden-browser-loading-caption">Just a sec...</div>
                </div>
              </div>
            </div>
          )}

          {/* 1. IDLE / INPUT STATE */}
          {!browserSession && (pillMode === "idle" || (effectiveEnteringVoice && pillMode !== "responding")) && (
            <>
              {/* Organic Collapsible Image Thumbnail Strip inside Compact Idle Pill */}
              {pillMode === "idle" && !effectiveEnteringVoice && (
                <div className={`siri-idle-images-collapse ${hasActiveImages ? "is-open" : ""}`}>
                  <div className="siri-idle-images-inner">
                    <div className="siri-attached-images-strip">
                      {attachedImages.map((img) => (
                        <button
                          key={img.id}
                          type="button"
                          className={`siri-attached-thumb-chip ${img.entering ? "is-entering" : ""} ${
                            img.removing ? "is-removing" : ""
                          }`}
                          title={`Remove ${img.name}`}
                          aria-label={`Remove ${img.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeImageOrganically(img.id);
                          }}
                        >
                          <img src={img.dataUrl} alt={img.name} className="siri-attached-thumb-img" />
                          <span className="siri-attached-thumb-overlay" aria-hidden="true">
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                            >
                              <path d="M18 6L6 18" />
                              <path d="M6 6l12 12" />
                            </svg>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="siri-idle-top-bar">
                <div
                  className={`siri-pill-input-wrap ${
                    effectiveEnteringVoice ? "entering-voice" : ""
                  }`}
                >
                  <div className="siri-input-track">
                    <div ref={pillMirrorRef} className="siri-cursor-mirror pill-mirror" aria-hidden="true">
                      {cursorPrefix}
                      <span ref={pillMarkerRef} className="siri-caret-marker">
                        &#8288;
                      </span>
                      {cursorSuffix}
                    </div>
                    {!hasTextSelection && caretPos.visible && (
                      <span
                        className={`siri-shining-cursor ${
                          shouldShowSearchDrawer && drawerSelectedIndex >= 0 ? "drawer-dimmed" : ""
                        }`}
                        style={{
                          transform: `translate3d(${caretPos.left}px, ${caretPos.top}px, 0)`,
                        }}
                        aria-hidden="true"
                      />
                    )}
                    <textarea
                      ref={pillInputRef}
                      rows={1}
                      className={`siri-pill-input ${isMultiline ? "multiline" : ""}`}
                      placeholder="Search or Ask"
                      value={inputText}
                      onChange={(e) => {
                        const val = e.target.value;
                        setInputText(val);
                        setDrawerSelectedIndex(-1);
                        if (val.trim().length === 0) {
                          setDrawerForceOpen(false);
                        }
                        updateSelection(e.target);
                        adjustTextareaHeight(e.target);
                      }}
                      onFocus={(e) => updateSelection(e.currentTarget)}
                      onSelect={(e) => updateSelection(e.currentTarget)}
                      onKeyUp={(e) => updateSelection(e.currentTarget)}
                      onClick={(e) => {
                        setDrawerSelectedIndex(-1);
                        updateSelection(e.currentTarget);
                      }}
                      onScroll={() => measureActiveCaret()}
                      onKeyDown={(e) => {
                        handleKeyDown(e);
                        const target = e.currentTarget;
                        window.requestAnimationFrame(() => updateSelection(target));
                      }}
                      spellCheck={false}
                    />
                  </div>
                </div>

                {/* Clickable Far-End Deep Reason Brain Toggle (Organic Enter & Exit!) */}
                <button
                  type="button"
                  className={`siri-deep-reason-bar-btn ${deepReason ? "is-active" : ""} ${
                    effectiveEnteringVoice ? "entering-voice" : ""
                  }`}
                  title="Deep Reason (High Effort) — Click to disable"
                  aria-label="Disable Deep Reason"
                  tabIndex={deepReason ? 0 : -1}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeepReason(false);
                  }}
                >
                  <svg
                    className="brain-icon-main"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
                  </svg>
                  <svg
                    className="brain-icon-close"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M18 6L6 18" />
                    <path d="M6 6l12 12" />
                  </svg>
                </button>

                {/* Minimalist Bare Mic Icon (No background circle, just clean icon) */}
                <button
                  type="button"
                  className={`siri-idle-bare-mic-btn ${
                    effectiveEnteringVoice ? "entering-voice" : ""
                  }`}
                  title="Voice Input (Click or Hold Shift)"
                  aria-label="Voice input"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleVoiceMode(true);
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                </button>
              </div>

              {pillMode === "idle" && !effectiveEnteringVoice && (
                <>
                  <div className="siri-conjoined-divider" aria-hidden="true" />
                  <ConjoinedSearchTray
                    open={shouldShowSearchDrawer}
                    query={trimmedSearchQuery}
                    mode={searchResult?.mode ?? "recents"}
                    recents={searchResult?.recents ?? []}
                    apps={searchResult?.apps ?? []}
                    bookmarks={searchResult?.bookmarks ?? []}
                    files={searchResult?.files ?? []}
                    selectedIndex={drawerSelectedIndex}
                    onSelectIndex={setDrawerSelectedIndex}
                    onLaunchItem={triggerLaunchSearchItem}
                  />
                </>
              )}
            </>
          )}

          {/* 1.5. VOICE / LISTENING STATE (Compact Plump Capsule with Apple Siri Aurora) */}
          {!browserSession && pillMode === "listening" && !effectiveEnteringVoice && (
            <div
              className="siri-listening-content"
              onClick={(e) => {
                e.stopPropagation();
                toggleVoiceMode(false);
              }}
              title="Hold Shift to speak • Click or press Esc to return to Search"
            >
              {/* Apple Siri Fluid Aurora Edge Glow (Compact Capsule Mode) */}
              <div
                className={`siri-aurora-edge-container compact ${isRecording ? "recording" : "idle"}`}
                aria-hidden="true"
              >
                {/* 1. Idle Grey/White Smoky Aurora Layer (Gentle undulating hill) */}
                <div className="siri-aurora-layer idle-layer">
                  <div className="siri-aurora-cloud-stage">
                    <div className="siri-aurora-cloud idle-cloud-1" />
                    <div className="siri-aurora-cloud idle-cloud-2" />
                    <div className="siri-aurora-cloud idle-cloud-3" />
                    <div className="siri-aurora-cloud idle-cloud-crest" />
                  </div>
                </div>

                {/* 2. Active Cyan/Blue/White Siri Intelligence Aurora Layer (Vibrant, voice-reactive) */}
                <div
                  className="siri-aurora-layer active-layer"
                  style={{
                    transform: `scaleY(${activeScaleY.toFixed(3)}) scaleX(${activeScaleX.toFixed(3)})`,
                  }}
                >
                  <div className="siri-aurora-cloud-stage">
                    <div className="siri-aurora-cloud active-cloud-cyan" />
                    <div className="siri-aurora-cloud active-cloud-blue" />
                    <div className="siri-aurora-cloud active-cloud-white" />
                    <div className="siri-aurora-cloud active-cloud-amber" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. THINKING STATE (Pill shrinks by 1/3, glowing pulse, shows status tag) */}
          {!browserSession && pillMode === "thinking" && (
            <div className="siri-thinking-content">
              <div className="siri-icon-morph-anchor">
                <span
                  className={`siri-apple-constellation ${isConnecting ? "is-imploded" : ""}`}
                  aria-hidden="true"
                >
                  <AppleConstellationSpinner />
                </span>
                {activeConnectorMeta && (
                  <div className={`siri-connector-sine-wrapper ${isConnecting ? "is-active" : ""}`}>
                    <img
                      src={activeConnectorMeta.icon}
                      alt={activeConnectorMeta.name}
                      className="siri-connector-sine-img"
                    />
                  </div>
                )}
              </div>
              <MorphingStatusText
                text={formatStatusTag(activeUiTag || "Thinking")}
                className="siri-thinking-text"
              />
            </div>
          )}

          {/* 3. RESPONDING STATE (Expands back to full length and vertically into glass window) */}
          {!browserSession && pillMode === "responding" && (
            <>
              {/* Floating Circular Clear Glass Close / Sleep Button (Top-Left) */}
              {onToggleSleep && (
                <button
                  ref={sleepBtnRef}
                  type="button"
                  className="siri-floating-close-btn left-sleep-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    sleepUi();
                  }}
                  title="Close (Esc)"
                  aria-label="Close"
                  tabIndex={isControlsVisible ? 0 : -1}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 6L6 18" />
                    <path d="M6 6l12 12" />
                  </svg>
                </button>
              )}

              {/* Floating Circular Colourless Clear Glass Minimize Button (Top-Right) */}
              <button
                ref={closeBtnRef}
                type="button"
                className="siri-floating-close-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  triggerMinimizeToPip();
                }}
                title="Minimize (Ctrl+M)"
                aria-label="Minimize"
                tabIndex={isControlsVisible ? 0 : -1}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 14V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
                  <rect x="8" y="8" width="13" height="12" rx="2.5" fill="currentColor" fillOpacity="0.2" />
                </svg>
              </button>

              {activeUiTag && !isMultiTurnMode && (
                <div className="siri-responding-header">
                  <div className="siri-responding-header-left">
                    <div className="siri-card-status-tag">
                      <div className="siri-icon-morph-anchor small">
                        <span
                          className={`siri-apple-constellation small ${isConnecting ? "is-imploded" : ""}`}
                          aria-hidden="true"
                        >
                          <AppleConstellationSpinner />
                        </span>
                        {activeConnectorMeta && (
                          <div className={`siri-connector-sine-wrapper small ${isConnecting ? "is-active" : ""}`}>
                            <img
                              src={activeConnectorMeta.icon}
                              alt={activeConnectorMeta.name}
                              className="siri-connector-sine-img"
                            />
                          </div>
                        )}
                      </div>
                      <MorphingStatusText
                        text={formatStatusTag(activeUiTag)}
                        className="siri-status-text"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div
                ref={streamContainerRef}
                className="siri-unified-stream"
                style={{
                  ...(isControlsVisible && (followupExtraH > 0 || hasActiveImages)
                    ? { paddingBottom: `${76 + followupExtraH + (hasActiveImages ? 56 : 0)}px` }
                    : {}),
                  "--stage-min-h": `${stageMinH}px`,
                } as React.CSSProperties}
                onScroll={updateScrollMask}
              >
                {activeTurns.map((turn, turnIdx) => {
                  const isActiveTurnStage =
                    activeTurns.length > 1 &&
                    turnIdx === activeTurns.length - 1 &&
                    !hasFollowupPending;
                  const hasTurnImages = Boolean(turn.userImages && turn.userImages.length > 0);
                  return (
                  <div
                    key={turn.id}
                    className={`siri-turn-item ${isActiveTurnStage ? "active-turn-stage" : ""}`}
                  >
                    {/* Turn 2+ user prompt bubble & attached user images */}
                    {(turn.userPrompt || hasTurnImages) && (
                      <div className="siri-user-followup-wrap">
                        {hasTurnImages && (
                          <div className="siri-user-bubble-images">
                            {turn.userImages!.map((img, imgIdx) => (
                              <img
                                key={`${turn.id}-uimg-${imgIdx}`}
                                src={img.dataUrl}
                                alt={img.name || "Attached image"}
                                title={img.name || "Attached image"}
                                className="siri-user-bubble-img"
                              />
                            ))}
                          </div>
                        )}
                        {turn.userPrompt && (
                          <div className="siri-user-followup-bubble">
                            <span className="siri-bubble-label">{turn.userPrompt}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Assistant Reply for this turn */}
                    {turn.assistantReply && (
                      <div className="siri-assistant-reply">
                        {turn.reasoningEffort === "high" && (
                          <div className="siri-deep-reason-reply-chip" title="Answered with Deep Reason (High Effort)">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.1"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                              <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                              <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
                            </svg>
                            <span>Deep Reason</span>
                          </div>
                        )}
                        {parseMessageWithGalleries(turn.assistantReply, Boolean(turn.isStreaming)).map((part, idx) => {
                          if (part.type === "text") {
                            return (
                              <div key={idx} className="siri-text-block">
                                <MarkdownContent content={part.text} />
                              </div>
                            );
                          }

                          if (part.type === "loading_gallery") {
                            return (
                              <div key={idx} className="siri-media-gallery loading single-item">
                                <div className="siri-media-skeleton" />
                              </div>
                            );
                          }

                          if (part.type === "location") {
                            return (
                              <LocationCard
                                key={idx}
                                lat={part.data.lat}
                                lon={part.data.lon}
                                title={part.data.title}
                              />
                            );
                          }

                          if (part.type === "loading_location") {
                            return (
                              <div key={idx} className="siri-location-card loading">
                                <div className="siri-location-skeleton" />
                              </div>
                            );
                          }

                          if (part.type === "gmail") {
                            return (
                              <GmailCard
                                key={idx}
                                count={part.data.count}
                                emails={part.data.emails}
                                subtitle={part.data.subtitle}
                                mode={part.data.mode}
                                query={part.data.query}
                                id={part.data.id}
                                sender={part.data.sender}
                                email={part.data.email}
                                date={part.data.date}
                                subject={part.data.subject}
                                summary={part.data.summary}
                                avatar={part.data.avatar}
                                onSelectEmail={(item) => {
                                  if (onSendMessage && item.id) {
                                    onSendMessage(`Read email ${item.id}`, false);
                                  }
                                }}
                                onAction={(action, emailId, senderName) => {
                                  if (!onSendMessage) return;
                                  if (action === "reply") {
                                    onSendMessage(`Reply to email from ${senderName || "sender"}: `, true);
                                  } else if (action === "archive") {
                                    onSendMessage(`Archive email ${emailId || ""}`, false);
                                  } else if (action === "mark_unread") {
                                    onSendMessage(`Mark email ${emailId || ""} as unread`, false);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "calendar") {
                            return (
                              <CalendarCard
                                key={idx}
                                mode={part.data.mode}
                                label={part.data.label}
                                count={part.data.count}
                                events={part.data.events}
                                event={part.data.event}
                                query={part.data.query}
                                oldTime={part.data.oldTime}
                                newTime={part.data.newTime}
                                timeWindow={part.data.timeWindow}
                                isFree={part.data.isFree}
                                conflicts={part.data.conflicts}
                                suggestedSlot={part.data.suggestedSlot}
                                onAction={(action, payload) => {
                                  if (!onSendMessage) return;
                                  if (action === "reschedule") {
                                    const title = payload?.summary || "event";
                                    onSendMessage(`Reschedule "${title}" to `, true);
                                  } else if (action === "schedule") {
                                    onSendMessage(`Schedule event for ${payload || "tomorrow"}: `, true);
                                  } else if (action === "book_suggested") {
                                    onSendMessage(`Book event during ${payload}`, true);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "spotify_artist") {
                            return (
                              <SpotifyArtistCard
                                key={idx}
                                {...part.data}
                                onPlayItem={(id, type, title) => {
                                  if (onSpotifyPlay && id) {
                                    onSpotifyPlay(id, type);
                                  } else if (onSendMessage) {
                                    onSendMessage(`play ${title || part.data.name}`, false);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "spotify_tracks") {
                            return (
                              <SpotifyTracksCard
                                key={idx}
                                {...part.data}
                                onPlayItem={(id, type, title) => {
                                  if (onSpotifyPlay && id) {
                                    onSpotifyPlay(id, type);
                                  } else if (onSendMessage) {
                                    onSendMessage(`play ${title}`, false);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "spotify_albums") {
                            return (
                              <SpotifyAlbumsCard
                                key={idx}
                                {...part.data}
                                onPlayItem={(id, type, title) => {
                                  if (onSpotifyPlay && id) {
                                    onSpotifyPlay(id, type);
                                  } else if (onSendMessage) {
                                    onSendMessage(`play album ${title}`, false);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "spotify_playlists") {
                            return (
                              <SpotifyPlaylistsCard
                                key={idx}
                                {...part.data}
                                onPlayItem={(id, type, title) => {
                                  if (onSpotifyPlay && id) {
                                    onSpotifyPlay(id, type);
                                  } else if (onSendMessage) {
                                    onSendMessage(`play playlist ${title}`, false);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "spotify_library_playlists") {
                            return (
                              <SpotifyLibraryPlaylistsCard
                                key={idx}
                                {...part.data}
                                onPlayItem={(id, type, title) => {
                                  if (onSpotifyPlay && id) {
                                    onSpotifyPlay(id, type);
                                  } else if (onSendMessage) {
                                    onSendMessage(`play playlist ${title}`, false);
                                  }
                                }}
                              />
                            );
                          }

                          if (part.type === "weather") {
                            return (
                              <WeatherCard
                                key={idx}
                                location={part.data.location}
                                temp={part.data.temp}
                                tempHigh={part.data.tempHigh}
                                tempLow={part.data.tempLow}
                                unit={part.data.unit}
                                condition={part.data.condition}
                                conditionKey={part.data.conditionKey}
                                weatherCode={part.data.weatherCode}
                                isDay={part.data.isDay}
                              />
                            );
                          }

                          if (part.type === "system_slider") {
                            return (
                              <SystemSlider
                                key={idx}
                                type={part.data.type}
                                level={part.data.level}
                                muted={part.data.muted}
                                onHardwareChange={onHardwareChange}
                              />
                            );
                          }

                          if (part.type === "loading_a2ui") {
                            return (
                              <div key={idx} className="a2ui-loading-card">
                                <span className="a2ui-loading-dot" aria-hidden="true" />
                                <span>Polishing interactive UI…</span>
                              </div>
                            );
                          }

                          if (part.type === "a2ui") {
                            return (
                              <A2UISurface
                                key={part.data.createSurface?.surfaceId || idx}
                                surface={part.data}
                                onAction={onA2UIAction}
                                onPrefillInput={handleA2UIPrefill}
                                onLayoutChange={() => window.requestAnimationFrame(updateScrollMask)}
                              />
                            );
                          }

                          if (part.type === "loading_youtube") {
                            return <YouTubeLoadingSkeleton key={idx} />;
                          }

                          if (part.type === "youtube") {
                            return (
                              <YouTubeCard
                                key={idx}
                                data={part.data}
                                onLayoutChange={() => window.requestAnimationFrame(updateScrollMask)}
                              />
                            );
                          }
                          return (
                            <div key={idx} className={`siri-media-gallery ${part.items.length === 1 ? "single-item" : ""}`}>
                              {part.items.map((item, imgIdx) => (
                                <div
                                  key={imgIdx}
                                  className="siri-media-card"
                                  title={item.title || "Image"}
                                >
                                  <img src={item.url} alt={item.title || "Image"} className="siri-media-img" />
                                  {item.title && (
                                    <div className="siri-media-caption-bar">
                                      <span className="siri-media-caption">{item.title}</span>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        })}

                        {/* Symbiote Connector Footer: Shows active connectors utilized in this turn */}
                        {!turn.isStreaming && turn.connectors && turn.connectors.length > 0 && (
                          <div className="siri-turn-symbiote-footer">
                            {turn.connectors.map((connKey) => {
                              const meta = resolveConnectorMeta(connKey, connKey);
                              if (!meta) return null;
                              return (
                                <div key={connKey} className="siri-symbiote-badge" title={`Connected via ${meta.name} connector`}>
                                  <img src={meta.icon} alt={meta.name} className="siri-symbiote-icon" />
                                  <span className="siri-symbiote-label">Connected to {meta.name}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Live Inline Antigravity Task Card anchored inside the turn that launched it */}
                    {showInlineAgyCard &&
                      agyWorkJob &&
                      agyWorkJob.anchorTurnId === turn.id &&
                      onDismissAgyCard &&
                      onStopAgyTask && (
                        <AntigravityWorkCard
                          job={agyWorkJob}
                          onDismiss={onDismissAgyCard}
                          onStop={onStopAgyTask}
                        />
                      )}

                    {/* Live Inline File Explorer Swarm Card anchored inside the turn that launched it */}
                    {fileAgentJob &&
                      fileAgentJob.anchorTurnId === turn.id &&
                      onStopFileAgent &&
                      onOpenFilePath && (
                        <FileAgentCard
                          job={fileAgentJob}
                          onStop={onStopFileAgent}
                          onOpenPath={onOpenFilePath}
                          onLayoutChange={() => window.requestAnimationFrame(updateScrollMask)}
                        />
                      )}
                  </div>
                  );
                })}

                {/* Unanchored Live Inline Antigravity & File Explorer Cards when no follow-up turn is in-flight
                    (e.g. Turn 1 fresh launch or waking AIDEN while a background job is still running) */}
                {!hasFollowupPending &&
                  !isProactiveThinkingInStream &&
                  activeUiTag &&
                  activeTurns.length === 0 &&
                  isMultiTurnMode && (
                    <div className="siri-turn-item proactive-pending-turn">
                      <div className="siri-instream-thinking">
                        <div className="siri-icon-morph-anchor">
                          <span
                            className={`siri-apple-constellation ${isConnecting ? "is-imploded" : ""}`}
                            aria-hidden="true"
                          >
                            <AppleConstellationSpinner />
                          </span>
                          {activeConnectorMeta && (
                            <div className={`siri-connector-sine-wrapper ${isConnecting ? "is-active" : ""}`}>
                              <img
                                src={activeConnectorMeta.icon}
                                alt={activeConnectorMeta.name}
                                className="siri-connector-sine-img"
                              />
                            </div>
                          )}
                        </div>
                        <MorphingStatusText
                          text={formatStatusTag(activeUiTag)}
                          className="siri-instream-thinking-text"
                        />
                      </div>
                    </div>
                  )}

                {!hasFollowupPending &&
                  showInlineAgyCard &&
                  agyWorkJob &&
                  (!agyWorkJob.anchorTurnId || !activeTurns.some((t) => t.id === agyWorkJob.anchorTurnId)) &&
                  onDismissAgyCard &&
                  onStopAgyTask && (
                    <div className="siri-turn-item agy-inline-orphan-turn">
                      <AntigravityWorkCard
                        job={agyWorkJob}
                        onDismiss={onDismissAgyCard}
                        onStop={onStopAgyTask}
                      />
                    </div>
                  )}

                {!hasFollowupPending &&
                  fileAgentJob &&
                  (!fileAgentJob.anchorTurnId || !activeTurns.some((t) => t.id === fileAgentJob.anchorTurnId)) &&
                  onStopFileAgent &&
                  onOpenFilePath && (
                    <div className="siri-turn-item agy-inline-orphan-turn">
                      <FileAgentCard
                        job={fileAgentJob}
                        onStop={onStopFileAgent}
                        onOpenPath={onOpenFilePath}
                        onLayoutChange={() => window.requestAnimationFrame(updateScrollMask)}
                      />
                    </div>
                  )}

                {/* Proactive In-Stream Status (e.g. Antigravity finished announcement or card-dismiss reply) */}
                {isProactiveThinkingInStream && (
                  <div className="siri-turn-item proactive-pending-turn">
                    <div className="siri-instream-thinking">
                      <div className="siri-icon-morph-anchor">
                        <span
                          className={`siri-apple-constellation ${isConnecting ? "is-imploded" : ""}`}
                          aria-hidden="true"
                        >
                          <AppleConstellationSpinner />
                        </span>
                        {activeConnectorMeta && (
                          <div className={`siri-connector-sine-wrapper ${isConnecting ? "is-active" : ""}`}>
                            <img
                              src={activeConnectorMeta.icon}
                              alt={activeConnectorMeta.name}
                              className="siri-connector-sine-img"
                            />
                          </div>
                        )}
                      </div>
                      <MorphingStatusText
                        text={formatStatusTag(activeUiTag || "Antigravity finished")}
                        className="siri-instream-thinking-text"
                      />
                    </div>
                  </div>
                )}

                {/* In-Flight Follow-up Prompt Bubble / Attached Images + Constellation Spinner */}
                {hasFollowupPending && (
                  <div className="siri-turn-item pending-turn">
                    <div ref={pendingWrapRef} className="siri-user-followup-wrap">
                      {followupThinkingImages && followupThinkingImages.length > 0 && (
                        <div className="siri-user-bubble-images">
                          {followupThinkingImages.map((img, imgIdx) => (
                            <img
                              key={`pending-img-${imgIdx}`}
                              src={img.dataUrl}
                              alt={img.name || "Attached image"}
                              className="siri-user-bubble-img"
                            />
                          ))}
                        </div>
                      )}
                      {followupThinkingPrompt && (
                        <div ref={pendingBubbleRef} className="siri-user-followup-bubble bubble-awaiting">
                          <span ref={pendingLabelRef} className="siri-bubble-label">
                            {followupThinkingPrompt}
                          </span>
                        </div>
                      )}
                    </div>
                    <div ref={pendingStatusRef} className="siri-instream-thinking status-awaiting">
                      <div className="siri-icon-morph-anchor">
                        <span
                          className={`siri-apple-constellation ${isConnecting ? "is-imploded" : ""}`}
                          aria-hidden="true"
                        >
                          <AppleConstellationSpinner />
                        </span>
                        {activeConnectorMeta && (
                          <div className={`siri-connector-sine-wrapper ${isConnecting ? "is-active" : ""}`}>
                            <img
                              src={activeConnectorMeta.icon}
                              alt={activeConnectorMeta.name}
                              className="siri-connector-sine-img"
                            />
                          </div>
                        )}
                      </div>
                      <MorphingStatusText
                        text={formatStatusTag(activeUiTag || "Thinking")}
                        className="siri-instream-thinking-text"
                      />
                    </div>

                    {/* Mid-launch Agy / File Agent panels live inside the active pending turn right below the tool status */}
                    {showInlineAgyCard &&
                      agyWorkJob &&
                      (!agyWorkJob.anchorTurnId || !activeTurns.some((t) => t.id === agyWorkJob.anchorTurnId)) &&
                      onDismissAgyCard &&
                      onStopAgyTask && (
                        <AntigravityWorkCard
                          job={agyWorkJob}
                          onDismiss={onDismissAgyCard}
                          onStop={onStopAgyTask}
                        />
                      )}

                    {fileAgentJob &&
                      (!fileAgentJob.anchorTurnId || !activeTurns.some((t) => t.id === fileAgentJob.anchorTurnId)) &&
                      onStopFileAgent &&
                      onOpenFilePath && (
                        <FileAgentCard
                          job={fileAgentJob}
                          onStop={onStopFileAgent}
                          onOpenPath={onOpenFilePath}
                          onLayoutChange={() => window.requestAnimationFrame(updateScrollMask)}
                        />
                      )}
                  </div>
                )}
              </div>

              {/* Apple-style Bottom Frosted Dissolve Shroud */}
              <div
                className={`siri-bottom-dissolve-shroud ${isControlsVisible ? "controls-visible" : ""}`}
                aria-hidden="true"
              />

              {/* Apple Siri Fluid Aurora Edge Glow (Expanded UI Voice Mode) */}
              {voiceActive && pillMode === "responding" && (
                <div
                  className={`siri-aurora-edge-container ${isRecording ? "recording" : "idle"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleVoiceMode(false);
                  }}
                  title="Press Space or click to exit Voice Mode"
                  aria-hidden="true"
                >
                  {/* 1. Idle Grey/White Smoky Aurora Layer (Slow, relaxed, undulating) */}
                  <div className="siri-aurora-layer idle-layer">
                    <div className="siri-aurora-cloud-stage">
                      <div className="siri-aurora-cloud idle-cloud-1" />
                      <div className="siri-aurora-cloud idle-cloud-2" />
                      <div className="siri-aurora-cloud idle-cloud-3" />
                      <div className="siri-aurora-cloud idle-cloud-crest" />
                    </div>
                  </div>

                  {/* 2. Active Cyan/Blue/White Siri Intelligence Aurora Layer (Vibrant, voice-reactive) */}
                  <div
                    className="siri-aurora-layer active-layer"
                    style={{
                      transform: `scaleY(${activeScaleY.toFixed(3)}) scaleX(${activeScaleX.toFixed(3)})`,
                    }}
                  >
                    <div className="siri-aurora-cloud-stage">
                      <div className="siri-aurora-cloud active-cloud-cyan" />
                      <div className="siri-aurora-cloud active-cloud-blue" />
                      <div className="siri-aurora-cloud active-cloud-white" />
                      <div className="siri-aurora-cloud active-cloud-amber" />
                    </div>
                  </div>
                </div>
              )}

              {/* Apple-style Persistent Follow-up Command Bar */}
              <div
                ref={followupBarRef}
                className={`siri-hover-followup-bar ${isControlsVisible ? "controls-visible" : ""} ${
                  isPlusTrayOpen ? "tray-open" : ""
                }`}
              >
                {/* Floating Scroll-to-Bottom Mini Pill ("↓ Latest") — detaches upward from Ask Aiden */}
                <div ref={scrollBottomAnchorRef} className="siri-scroll-bubble-anchor">
                  <button
                    ref={scrollBottomBtnRef}
                    type="button"
                    className={`siri-scroll-bottom-pill ${
                      scrollBottomState === "visible"
                        ? "is-visible is-entering"
                        : scrollBottomState === "leaving"
                        ? "is-visible is-leaving"
                        : ""
                    }`}
                    tabIndex={scrollBottomState === "visible" && !isPlusTrayOpen ? 0 : -1}
                    title="Scroll to latest"
                    aria-label="Scroll to latest"
                    onMouseEnter={() => runLensSyncFor(240)}
                    onMouseLeave={() => runLensSyncFor(240)}
                    onMouseDown={() => runLensSyncFor(180)}
                    onClick={handleScrollToBottom}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.35"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 5v13M6 13l6 6 6-6" />
                    </svg>
                    <span>Latest</span>
                  </button>
                </div>

                <div className={`siri-apple-command-bar ${isPlusTrayOpen ? "tray-open" : ""}`}>
                  {/* Animated spacer reserving [+] slot; collapses smoothly to 0px so Ask Aiden stretches left */}
                  <div className="plus-slot-spacer" aria-hidden="true" />

                  {/* Single Continuous Liquid-Glass Surface: circular [+] button that lifts & morphs into frosted arch-shine tray */}
                  <div
                    ref={plusBtnRef}
                    className={`siri-plus-morph-surface ${isPlusTrayOpen ? "is-open" : ""}`}
                    role="button"
                    title={isPlusTrayOpen ? undefined : "Add image or toggle Deep Reason"}
                    aria-label="Open actions tray"
                    aria-expanded={isPlusTrayOpen}
                    tabIndex={isControlsVisible ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isPlusTrayOpen) {
                        setIsPlusTrayOpen(true);
                      }
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !isPlusTrayOpen) {
                        e.preventDefault();
                        e.stopPropagation();
                        setIsPlusTrayOpen(true);
                      }
                    }}
                  >
                    <div className="morph-plus-glyph" aria-hidden="true">
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </div>

                    <div className="morph-tray-content" role="menu">
                      <button
                        type="button"
                        className="siri-tray-action-item"
                        role="menuitem"
                        tabIndex={isPlusTrayOpen ? 0 : -1}
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsPlusTrayOpen(false);
                          fileInputRef.current?.click();
                        }}
                      >
                        <span className="siri-tray-item-left">
                          <svg
                            className="siri-tray-item-icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect x="3" y="3" width="18" height="18" rx="3" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <path d="M21 15l-5-5L5 21" />
                          </svg>
                          <span>Add image</span>
                        </span>
                      </button>

                      <button
                        type="button"
                        className={`siri-tray-action-item ${deepReason ? "is-enabled" : ""}`}
                        role="menuitemcheckbox"
                        aria-checked={deepReason}
                        tabIndex={isPlusTrayOpen ? 0 : -1}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeepReason((prev) => !prev);
                          setIsPlusTrayOpen(false);
                        }}
                      >
                        <span className="siri-tray-item-left">
                          <svg
                            className="siri-tray-item-icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
                          </svg>
                          <span>Deep Reason</span>
                        </span>
                        <span className="siri-tray-status-pill">ON</span>
                      </button>
                    </div>
                  </div>

                  {/* Center: Frosted Capsule Input with Organic Image Strip + "Ask Aiden" + Brain Toggle */}
                  <div
                    ref={capsuleRef}
                    className={`siri-command-capsule ${hasActiveImages ? "has-images" : ""} ${
                      isProactiveAnnouncementActive ? "announcement-locked" : ""
                    } ${announcementBlockPulse ? "announcement-pulse" : ""}`}
                  >
                    <div ref={scrollBottomRimRef} className="siri-capsule-rim-bloom" aria-hidden="true" />
                    <div className={`siri-attached-strip-collapse ${hasActiveImages ? "is-open" : ""}`}>
                      <div className="siri-attached-strip-collapse-inner">
                        <div className="siri-attached-images-strip">
                          {attachedImages.map((img) => (
                            <button
                              key={img.id}
                              type="button"
                              className={`siri-attached-thumb-chip ${img.entering ? "is-entering" : ""} ${
                                img.removing ? "is-removing" : ""
                              }`}
                              title={`Remove ${img.name}`}
                              aria-label={`Remove ${img.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeImageOrganically(img.id);
                              }}
                            >
                              <img src={img.dataUrl} alt={img.name} className="siri-attached-thumb-img" />
                              <span className="siri-attached-thumb-overlay" aria-hidden="true">
                                <svg
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                >
                                  <path d="M18 6L6 18" />
                                  <path d="M6 6l12 12" />
                                </svg>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="siri-capsule-input-row">
                      <div className="siri-input-track">
                        <div
                          ref={followupMirrorRef}
                          className="siri-cursor-mirror followup-mirror"
                          aria-hidden="true"
                        >
                          {cursorPrefix}
                          <span ref={followupMarkerRef} className="siri-caret-marker">
                            &#8288;
                          </span>
                          {cursorSuffix}
                        </div>
                        {isInputFocused && !hasTextSelection && caretPos.visible && (
                          <span
                            className="siri-shining-cursor followup-cursor"
                            style={{
                              transform: `translate3d(${caretPos.left}px, ${caretPos.top}px, 0)`,
                            }}
                            aria-hidden="true"
                          />
                        )}
                        <textarea
                          ref={followupInputRef}
                          rows={1}
                          className="siri-command-input"
                          placeholder={
                            isProactiveAnnouncementActive
                              ? "AIDEN is reporting a finished task..."
                              : "Ask Aiden"
                          }
                          value={inputText}
                          onChange={(e) => {
                            setInputText(e.target.value);
                            updateSelection(e.target);
                            adjustTextareaHeight(e.target);
                          }}
                          onFocus={(e) => {
                            setIsInputFocused(true);
                            updateSelection(e.currentTarget);
                          }}
                          onBlur={() => setIsInputFocused(false)}
                          onSelect={(e) => updateSelection(e.currentTarget)}
                          onKeyUp={(e) => updateSelection(e.currentTarget)}
                          onClick={(e) => updateSelection(e.currentTarget)}
                          onScroll={() => measureActiveCaret()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              handleSend();
                              return;
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              if (isPlusTrayOpen) {
                                setIsPlusTrayOpen(false);
                              } else {
                                sleepUi();
                              }
                              return;
                            }
                            const target = e.currentTarget;
                            window.requestAnimationFrame(() => updateSelection(target));
                          }}
                          spellCheck={false}
                        />
                      </div>

                      {/* Far-Right Clickable Monochrome Deep Reason Brain Icon (Organic Enter & Exit!) */}
                      <button
                        type="button"
                        className={`siri-deep-reason-bar-btn ${deepReason ? "is-active" : ""}`}
                        title="Deep Reason (High Effort) — Click to disable"
                        aria-label="Disable Deep Reason"
                        tabIndex={deepReason && isControlsVisible ? 0 : -1}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeepReason(false);
                        }}
                      >
                        <svg
                          className="brain-icon-main"
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
                          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
                          <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
                        </svg>
                        <svg
                          className="brain-icon-close"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        >
                          <path d="M18 6L6 18" />
                          <path d="M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Right: Circular Frosted Glass Mic Button */}
                  <button
                    ref={micBtnRef}
                    type="button"
                    className="siri-command-glass-btn mic-btn"
                    title="Dictate with Siri (Press Space to cancel)"
                    aria-label="Voice input"
                    tabIndex={isControlsVisible ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsPlusTrayOpen(false);
                      toggleVoiceMode(true);
                    }}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                  </button>
                </div>
              </div>


            </>
          )}
        </div>
      </div>
    </div>
  );
};

interface ChatPillSyncPayload {
  isAwake?: boolean | null;
  backendOnline?: boolean | null;
  isDarkMode?: boolean | null;
  reply?: string | null;
  expanded?: boolean | null;
}

/**
 * Standalone Window Container for the Siri-Style AI Pill ("chat_pill" window)
 */
export const ChatPillWindow: React.FC = () => {
  const [isBackendOnline, setIsBackendOnline] = useState(false);
  const [isAwake, setIsAwake] = useState(false);
  const offlineGraceTimerRef = useRef<number | null>(null);

  const clearOfflineGraceTimer = useCallback(() => {
    if (offlineGraceTimerRef.current !== null) {
      window.clearTimeout(offlineGraceTimerRef.current);
      offlineGraceTimerRef.current = null;
    }
  }, []);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [followupThinkingPrompt, setFollowupThinkingPrompt] = useState<string | null>(null);
  const [followupThinkingImages, setFollowupThinkingImages] = useState<
    Array<{ name: string; dataUrl: string }> | null
  >(null);
  const [activeUiTag, setActiveUiTag] = useState<string | null>(null);
  const [activeConnector, setActiveConnector] = useState<string | null>(null);
  const currentTurnConnectorsRef = useRef<Set<string>>(new Set());
  const [isStreaming, setIsStreaming] = useState(false);
  const [isMaxHeight, setIsMaxHeight] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef<boolean>(false);
  isRecordingRef.current = isRecording;
  const [isExitingVoice, setIsExitingVoice] = useState(false);
  const exitingVoiceTimerRef = useRef<number | null>(null);
  const [isEnteringVoice, setIsEnteringVoice] = useState(false);
  const enteringVoiceTimerRef = useRef<number | null>(null);
  const [audioMeter, setAudioMeter] = useState({ level: 0, bass: 0, mid: 0, high: 0 });
  const wasOriginVoiceRef = useRef<boolean>(false);

  const handleToggleVoice = useCallback((active: boolean, skipSocket?: boolean) => {
    if (active) {
      wasOriginVoiceRef.current = true;
      setActiveUiTag(null);
    } else {
      wasOriginVoiceRef.current = false;
      setActiveUiTag(null);
    }

    if (!active) {
      isRecordingRef.current = false;
      setIsRecording(false);
    }
    if (!skipSocket && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: active ? "voice_arm" : "voice_disarm" }));
    }

    setIsVoiceActive((prev) => {
      const isResponding =
        turnsRef.current.length > 0 ||
        Boolean(followupThinkingPromptRef.current) ||
        Boolean(followupThinkingImagesRef.current && followupThinkingImagesRef.current.length > 0);
      if (isResponding) {
        return active;
      }

      if (prev && !active) {
        setIsEnteringVoice(false);
        if (enteringVoiceTimerRef.current !== null) {
          window.clearTimeout(enteringVoiceTimerRef.current);
          enteringVoiceTimerRef.current = null;
        }
        setIsExitingVoice(true);
        if (exitingVoiceTimerRef.current !== null) {
          window.clearTimeout(exitingVoiceTimerRef.current);
        }
        exitingVoiceTimerRef.current = window.setTimeout(() => {
          setIsExitingVoice(false);
          exitingVoiceTimerRef.current = null;
        }, 480);
      } else if (active) {
        setIsExitingVoice(false);
        if (exitingVoiceTimerRef.current !== null) {
          window.clearTimeout(exitingVoiceTimerRef.current);
          exitingVoiceTimerRef.current = null;
        }
        setIsEnteringVoice(true);
        if (enteringVoiceTimerRef.current !== null) {
          window.clearTimeout(enteringVoiceTimerRef.current);
        }
        enteringVoiceTimerRef.current = window.setTimeout(() => {
          setIsEnteringVoice(false);
          enteringVoiceTimerRef.current = null;
        }, 160);
      }
      return active;
    });
  }, []);

  const handleStartRecording = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "recording_start" }));
    }
    isRecordingRef.current = true;
    setIsRecording(true);
    setActiveUiTag(null);
  }, []);

  const handleStopRecording = useCallback(() => {
    if (!isRecordingRef.current) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "recording_stop" }));
    }
    isRecordingRef.current = false;
    setIsRecording(false);
    enterTurnPending(null, turnsRef.current.length > 0, false);
  }, []);

  // Global Push-to-Talk Shift key listener when in Voice Mode
  useEffect(() => {
    const handleShiftDown = (e: KeyboardEvent) => {
      if ((e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") && !e.repeat) {
        if (isVoiceActive && !isRecordingRef.current) {
          handleStartRecording();
        }
      }
    };

    const handleShiftUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (isVoiceActive && isRecordingRef.current) {
          handleStopRecording();
        }
      }
    };

    window.addEventListener("keydown", handleShiftDown);
    window.addEventListener("keyup", handleShiftUp);
    return () => {
      window.removeEventListener("keydown", handleShiftDown);
      window.removeEventListener("keyup", handleShiftUp);
    };
  }, [isVoiceActive, handleStartRecording, handleStopRecording]);

  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;
  const followupThinkingPromptRef = useRef<string | null>(null);
  const followupThinkingImagesRef = useRef<Array<{ name: string; dataUrl: string }> | null>(null);
  const pendingTurnEffortRef = useRef<"none" | "high">("none");
  const currentTurnIdRef = useRef<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const targetTextRef = useRef<string>("");
  const displayedLengthRef = useRef<number>(0);
  const streamEndedRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);
  const lastLineEmittedTimeRef = useRef<number>(0);
  const polishStartTimeRef = useRef<number>(0);
  const polishTimerRef = useRef<number | null>(null);
  const polishShuffleIntervalRef = useRef<number | null>(null);

  const stopPolishShuffle = useCallback(() => {
    if (polishShuffleIntervalRef.current !== null) {
      window.clearInterval(polishShuffleIntervalRef.current);
      polishShuffleIntervalRef.current = null;
    }
  }, []);

  const contentRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [agyWorkJob, setAgyWorkJob] = useState<AgyWorkJobState | null>(null);
  const [agyDoneSeq, setAgyDoneSeq] = useState(0);
  const [agyFailedSeq, setAgyFailedSeq] = useState(0);
  const [proactiveTurnKind, setProactiveTurnKind] = useState<string | null>(null);
  const pendingAgyAnchorJobIdRef = useRef<string | null>(null);
  const [fileAgentJob, setFileAgentJob] = useState<FileAgentJobState | null>(null);
  const pendingFileAgentAnchorJobIdRef = useRef<string | null>(null);
  const [browserSession, setBrowserSession] = useState<{
    url: string;
    loading: boolean;
    width: number;
    height: number;
  } | null>(null);
  const browserSessionRef = useRef(browserSession);
  browserSessionRef.current = browserSession;
  const preBrowserSizeRef = useRef<{ width: number; height: number }>({ width: 466, height: 60 });

  const stopStreamRaf = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  const resetReplyState = (skipSocket = false) => {
    stopStreamRaf();
    setIsVoiceActive(false);
    setIsExitingVoice(false);
    if (exitingVoiceTimerRef.current !== null) {
      window.clearTimeout(exitingVoiceTimerRef.current);
      exitingVoiceTimerRef.current = null;
    }
    setIsEnteringVoice(false);
    if (enteringVoiceTimerRef.current !== null) {
      window.clearTimeout(enteringVoiceTimerRef.current);
      enteringVoiceTimerRef.current = null;
    }
    currentTurnIdRef.current = null;
    followupThinkingPromptRef.current = null;
    setFollowupThinkingPrompt(null);
    followupThinkingImagesRef.current = null;
    setFollowupThinkingImages(null);
    pendingTurnEffortRef.current = "none";
    stopPolishShuffle();
    if (polishTimerRef.current !== null) {
      window.clearTimeout(polishTimerRef.current);
      polishTimerRef.current = null;
    }
    polishStartTimeRef.current = 0;
    turnsRef.current = [];
    setTurns([]);
    setActiveUiTag(null);
    setProactiveTurnKind(null);
    setIsStreaming(false);
    setIsMaxHeight(false);
    setAgyWorkJob((prev) => {
      if (!prev) return null;
      if (prev.status === "running") {
        return { ...prev, anchorTurnId: null };
      }
      return null;
    });
    setFileAgentJob((prev) => {
      if (!prev) return null;
      if (prev.status === "scan") {
        return { ...prev, anchorTurnId: null };
      }
      return null;
    });
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
    lastLineEmittedTimeRef.current = 0;
    if (browserSessionRef.current) {
      setBrowserSession(null);
      invoke("close_inbuilt_browser").catch(() => {});
    }

    if (!skipSocket && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "clear_response" }));
    }
  };

  function enterTurnPending(
    prompt: string | null,
    isFollowup: boolean,
    resetTimers = true,
    images?: Array<{ name: string; dataUrl: string }>,
    effort: "none" | "high" = "none"
  ) {
    if (resetTimers) {
      stopPolishShuffle();
      if (polishTimerRef.current !== null) {
        window.clearTimeout(polishTimerRef.current);
        polishTimerRef.current = null;
      }
      polishStartTimeRef.current = 0;
    }
    const cleanImgs = images && images.length > 0 ? images : null;
    pendingTurnEffortRef.current = effort;
    setActiveUiTag(
      effort === "high"
        ? "Deep Reasoning"
        : cleanImgs
        ? cleanImgs.length === 1
          ? "Inspecting image"
          : `Inspecting ${cleanImgs.length} images`
        : "Thinking"
    );
    if (isFollowup) {
      if (prompt !== null) {
        followupThinkingPromptRef.current = prompt;
        setFollowupThinkingPrompt(prompt);
      } else {
        followupThinkingPromptRef.current = null;
        setFollowupThinkingPrompt(null);
      }
      followupThinkingImagesRef.current = cleanImgs;
      setFollowupThinkingImages(cleanImgs);
      setIsMaxHeight(true);
    } else {
      turnsRef.current = [];
      setTurns([]);
      followupThinkingPromptRef.current = null;
      setFollowupThinkingPrompt(null);
      followupThinkingImagesRef.current = cleanImgs;
      setFollowupThinkingImages(null);
      setIsMaxHeight(false);
    }
  }

  function finalizeChatTurn(turn: ChatTurn, appendToExisting: boolean, nextUiTag: string | null) {
    followupThinkingPromptRef.current = null;
    setFollowupThinkingPrompt(null);
    followupThinkingImagesRef.current = null;
    setFollowupThinkingImages(null);
    pendingTurnEffortRef.current = "none";
    setActiveUiTag(nextUiTag);
    const nextTurns = appendToExisting ? [...turnsRef.current, turn] : [turn];
    turnsRef.current = nextTurns;
    setTurns(nextTurns);
  }

  const hasReplyText =
    turns.some(
      (t) =>
        Boolean(
          (t.assistantReply && t.assistantReply.trim().length > 0) ||
            t.userPrompt ||
            (t.userImages && t.userImages.length > 0)
        )
    ) ||
    Boolean(followupThinkingPrompt) ||
    Boolean(followupThinkingImages && followupThinkingImages.length > 0) ||
    Boolean(agyWorkJob && !agyWorkJob.cardDismissed && agyWorkJob.status === "running") ||
    Boolean(fileAgentJob && fileAgentJob.status === "scan");
  const isThinking = Boolean(!hasReplyText && activeUiTag);
  const currentMode: "idle" | "listening" | "thinking" | "responding" = hasReplyText
    ? "responding"
    : isThinking
    ? "thinking"
    : isVoiceActive
    ? "listening"
    : "idle";

  // Maintain latest mode ref for stable shape identity
  const currentModeRef = useRef(currentMode);
  currentModeRef.current = currentMode;

  // Native Window Morpher: The HWND itself is the pill
  const lastSyncWidthRef = useRef<number>(466);
  const lastSyncHeightRef = useRef<number>(60);
  const idleTargetHeightRef = useRef<number>(60);
  const hasOpenedOnceRef = useRef<boolean>(false);

  const [pipPhase, setPipPhase] = useState<PipPhase>("max");
  const pipPhaseRef = useRef<PipPhase>("max");
  pipPhaseRef.current = pipPhase;
  const pipPhaseTimerRef = useRef<number | null>(null);
  const pipRestoreHeightRef = useRef<number>(300);

  const clearPipTimer = () => {
    if (pipPhaseTimerRef.current !== null) {
      window.clearTimeout(pipPhaseTimerRef.current);
      pipPhaseTimerRef.current = null;
    }
  };

  const wasBackendOnlineRef = useRef<boolean>(false);
  const wasAwakeRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      clearPipTimer();
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      clearOfflineGraceTimer();
    };
  }, [clearOfflineGraceTimer]);

  // Manage Living Square / Pill lifecycle transitions:
  //   - Offline: fade & hide HWND
  //   - Online & Awake: spring from square (or hidden fallback) to compact pill
  //   - Online & Asleep: morph/persist as 68x68 living square
  useEffect(() => {
    const prevOnline = wasBackendOnlineRef.current;
    const prevAwake = wasAwakeRef.current;
    wasBackendOnlineRef.current = isBackendOnline;
    wasAwakeRef.current = isAwake;

    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    if (!isBackendOnline) {
      clearPipTimer();
      if (prevOnline || prevAwake || hasOpenedOnceRef.current) {
        if (prevAwake && pipPhaseRef.current !== "pip") {
          invoke("set_chat_pill_state", { isAwake: false }).catch(() => {});
        }
        hideTimerRef.current = window.setTimeout(() => {
          resetReplyState(true);
          lastSyncWidthRef.current = 466;
          lastSyncHeightRef.current = 60;
          idleTargetHeightRef.current = 60;
          pipPhaseRef.current = "max";
          setPipPhase("max");
          invoke("hide_chat_pill").catch(() => {});
          hideTimerRef.current = null;
        }, 280);
      }
      return;
    }

    if (isAwake) {
      if (!prevAwake || !prevOnline) {
        clearPipTimer();
        hasOpenedOnceRef.current = true;
        resetReplyState(true);
        lastSyncWidthRef.current = 466;
        lastSyncHeightRef.current = 60;
        idleTargetHeightRef.current = 60;

        if (pipPhaseRef.current === "pip" || pipPhaseRef.current === "to-pip") {
          pipPhaseRef.current = "to-max";
          setPipPhase("to-max");
          invoke("set_chat_pill_state", { isAwake: true }).catch(() => {});
          pipPhaseTimerRef.current = window.setTimeout(() => {
            pipPhaseTimerRef.current = null;
            pipPhaseRef.current = "max";
            setPipPhase("max");
          }, 320);
        } else {
          pipPhaseRef.current = "max";
          setPipPhase("max");
          invoke("set_chat_pill_state", { isAwake: true }).catch(() => {});
        }
      }
      return;
    }

    // isBackendOnline && !isAwake -> Living Asleep Square (68x68)
    if (!prevOnline) {
      clearPipTimer();
      resetReplyState(true);
      lastSyncWidthRef.current = 466;
      lastSyncHeightRef.current = 60;
      idleTargetHeightRef.current = 60;
      pipPhaseRef.current = "pip";
      setPipPhase("pip");
      invoke("enter_asleep_square", { size: 68 }).catch(() => {});
    } else if (prevAwake) {
      if (pipPhaseRef.current === "pip") {
        // Already sitting as Paused Chat Square: keep eyes/position uninterrupted and clear chat
        resetReplyState(false);
        lastSyncWidthRef.current = 466;
        lastSyncHeightRef.current = 60;
        idleTargetHeightRef.current = 60;
        invoke("enter_asleep_square", { size: 68 }).catch(() => {});
      } else if (pipPhaseRef.current === "to-pip") {
        // Mid-minimize morph to square: keep minimize animation intact, clear chat once landed
        invoke("enter_asleep_square", { size: 68 }).catch(() => {});
        hideTimerRef.current = window.setTimeout(() => {
          resetReplyState(false);
          lastSyncWidthRef.current = 466;
          lastSyncHeightRef.current = 60;
          idleTargetHeightRef.current = 60;
          hideTimerRef.current = null;
        }, 310);
      } else {
        // Morph down from Compact Pill or Extended Chat into 68x68 Asleep Square
        clearPipTimer();
        pipPhaseRef.current = "to-pip";
        setPipPhase("to-pip");
        invoke("enter_asleep_square", { size: 68 }).catch(() => {});
        pipPhaseTimerRef.current = window.setTimeout(() => {
          pipPhaseTimerRef.current = null;
          pipPhaseRef.current = "pip";
          setPipPhase("pip");
        }, 310);
        hideTimerRef.current = window.setTimeout(() => {
          resetReplyState(false);
          lastSyncWidthRef.current = 466;
          lastSyncHeightRef.current = 60;
          idleTargetHeightRef.current = 60;
          hideTimerRef.current = null;
        }, 310);
      }
    }
  }, [isBackendOnline, isAwake]);

  const handleMinimizeToPip = useCallback(
    (restoreH: number) => {
      if (!isAwake || (pipPhaseRef.current !== "max" && pipPhaseRef.current !== "to-max")) {
        return;
      }
      if (browserSessionRef.current) {
        setBrowserSession(null);
        invoke("close_inbuilt_browser").catch(() => {});
      }
      clearPipTimer();
      pipRestoreHeightRef.current = restoreH;
      pipPhaseRef.current = "to-pip";
      setPipPhase("to-pip");
      invoke("minimize_to_pip", { size: 68 }).catch(() => {});
      pipPhaseTimerRef.current = window.setTimeout(() => {
        pipPhaseTimerRef.current = null;
        pipPhaseRef.current = "pip";
        setPipPhase("pip");
      }, 310);
    },
    [isAwake]
  );

  const handleMaximizeFromPip = useCallback(() => {
    if (!isAwake || (pipPhaseRef.current !== "pip" && pipPhaseRef.current !== "to-pip")) {
      return;
    }
    clearPipTimer();
    const targetH = pipRestoreHeightRef.current || 300;
    lastSyncWidthRef.current = 466;
    lastSyncHeightRef.current = targetH;
    pipPhaseRef.current = "to-max";
    setPipPhase("to-max");
    invoke("maximize_from_pip", { width: 466, height: targetH }).catch(() => {});
    pipPhaseTimerRef.current = window.setTimeout(() => {
      pipPhaseTimerRef.current = null;
      pipPhaseRef.current = "max";
      setPipPhase("max");
    }, 340);
  }, [isAwake]);

  const handleSquareActivate = useCallback(() => {
    if (!isAwake) {
      setIsAwake(true);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "wake" }));
      }
      return;
    }
    handleMaximizeFromPip();
  }, [isAwake, handleMaximizeFromPip]);

  const isBackendOnlineRef = useRef(isBackendOnline);
  isBackendOnlineRef.current = isBackendOnline;
  const isAwakeRef = useRef(isAwake);
  isAwakeRef.current = isAwake;
  const handleSquareActivateRef = useRef(handleSquareActivate);
  handleSquareActivateRef.current = handleSquareActivate;
  const winMinimizeActionRef = useRef<(() => void) | null>(null);
  const lastWinToggleSeqRef = useRef<number>(0);

  // Native Left-Win key toggle emitted by Rust WH_KEYBOARD_LL hook (Awake <-> Minimize)
  useEffect(() => {
    let disposed = false;
    let unlistenWinKey: (() => void) | undefined;

    const setupWinKeyListener = async () => {
      try {
        const unlisten = await listen<{ seq?: number }>("aiden-win-key-toggle", (event) => {
          const seq = typeof event.payload?.seq === "number" ? event.payload.seq : 0;
          if (seq > 0) {
            if (seq <= lastWinToggleSeqRef.current) return;
            lastWinToggleSeqRef.current = seq;
          }
          if (!isBackendOnlineRef.current) {
            invoke("show_main_window").catch(() => {});
            return;
          }
          if (
            !isAwakeRef.current ||
            pipPhaseRef.current === "pip" ||
            pipPhaseRef.current === "to-pip"
          ) {
            handleSquareActivateRef.current();
          } else {
            winMinimizeActionRef.current?.();
          }
        });
        if (disposed) {
          unlisten();
        } else {
          unlistenWinKey = unlisten;
        }
      } catch {
        // Fallback when running outside Tauri
      }
    };

    setupWinKeyListener();

    return () => {
      disposed = true;
      if (unlistenWinKey) unlistenWinKey();
    };
  }, []);

  // Sync UI surface visibility (Maximized vs Living Cube) to backend Turn-Barrier Mailbox.
  // Runs AFTER the awake/sleep lifecycle effect so resetReplyState() completes before queued reports fire.
  useEffect(() => {
    const minimized = !isAwake || pipPhase === "pip" || pipPhase === "to-pip";
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "ui_surface",
          pipMinimized: minimized,
        })
      );
    }
  }, [isAwake, pipPhase]);

  const morphTo = useCallback(
    (targetWidth: number, targetHeight: number, durationMs = 280) => {
      if (!isAwake || pipPhaseRef.current !== "max" || browserSessionRef.current) return;
      if (
        Math.abs(targetWidth - lastSyncWidthRef.current) < 2 &&
        Math.abs(targetHeight - lastSyncHeightRef.current) < 4
      ) {
        return;
      }
      lastSyncWidthRef.current = targetWidth;
      lastSyncHeightRef.current = targetHeight;
      invoke("morph_pill", {
        targetWidth,
        targetHeight,
        durationMs,
      }).catch(() => {});
    },
    [isAwake]
  );

  // Sync mode changes with native HWND geometry
  useEffect(() => {
    if (!isAwake || pipPhaseRef.current !== "max" || browserSessionRef.current) return;
    if (currentMode === "listening") {
      morphTo(280, idleTargetHeightRef.current, 260);
    } else if (currentMode === "idle") {
      morphTo(466, idleTargetHeightRef.current, 200);
    } else if (currentMode === "thinking") {
      idleTargetHeightRef.current = 60;
      morphTo(466, 60, 200);
    } else if (currentMode === "responding") {
      idleTargetHeightRef.current = 60;
      // ChatPill's layout effect computes exact content clearance and invokes handlePillHeightChange
    }
  }, [currentMode, isAwake, morphTo]);

  // Sync theme changes with DWM Acrylic backdrop & border
  useEffect(() => {
    invoke("set_pill_theme", { darkMode: isDarkMode }).catch(() => {});
  }, [isDarkMode]);

  const handlePillHeightChange = useCallback(
    (targetH: number, durationMs = 220) => {
      if (!isAwake || pipPhaseRef.current !== "max" || browserSessionRef.current) return;
      if (currentMode === "idle") {
        idleTargetHeightRef.current = targetH;
        morphTo(466, targetH, durationMs);
      } else if (currentMode === "responding") {
        morphTo(466, targetH, durationMs);
      }
    },
    [isAwake, currentMode, morphTo]
  );

  const openAidenBrowser = useCallback(
    (rawUrl: string, width = 960, height = 600) => {
      const cleanUrl = (rawUrl || "").trim();
      if (!cleanUrl) return;
      if (!browserSessionRef.current) {
        preBrowserSizeRef.current = {
          width: lastSyncWidthRef.current || 466,
          height: Math.max(60, lastSyncHeightRef.current || 60),
        };
      }
      clearOfflineGraceTimer();
      setIsBackendOnline(true);
      if (!isAwakeRef.current) {
        setIsAwake(true);
        invoke("set_chat_pill_state", { isAwake: true }).catch(() => {});
      }
      if (pipPhaseRef.current !== "max") {
        clearPipTimer();
        pipPhaseRef.current = "max";
        setPipPhase("max");
      }
      lastSyncWidthRef.current = width;
      lastSyncHeightRef.current = height;
      const nextSession = { url: cleanUrl, loading: true, width, height };
      browserSessionRef.current = nextSession;
      setBrowserSession(nextSession);
      invoke("open_inbuilt_browser", { url: cleanUrl, width, height }).catch(() => {});
    },
    [clearOfflineGraceTimer]
  );

  const closeAidenBrowser = useCallback(() => {
    if (!browserSessionRef.current) return;
    browserSessionRef.current = null;
    setBrowserSession(null);
    invoke("close_inbuilt_browser").catch(() => {});
    const restoreW = 466;
    const restoreH =
      currentModeRef.current === "idle"
        ? Math.max(60, idleTargetHeightRef.current || 60)
        : Math.max(140, Math.min(620, preBrowserSizeRef.current.height || 340));
    lastSyncWidthRef.current = restoreW;
    lastSyncHeightRef.current = restoreH;
    invoke("morph_pill", {
      targetWidth: restoreW,
      targetHeight: restoreH,
      durationMs: 240,
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const onOpenBrowserEvent = (ev: Event) => {
      const customEv = ev as CustomEvent<AidenBrowserOpenDetail>;
      const targetUrl = customEv?.detail?.url;
      if (typeof targetUrl === "string" && targetUrl) {
        openAidenBrowser(targetUrl, 960, 600);
      }
    };
    window.addEventListener(AIDEN_BROWSER_OPEN_EVENT, onOpenBrowserEvent as EventListener);

    let disposed = false;
    let unlistenNav: (() => void) | undefined;
    let unlistenLoad: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;
    let unlistenExternal: (() => void) | undefined;

    const attachBrowserEvents = async () => {
      try {
        const uNav = await listen<{ url?: string }>("aiden-browser-navigated", (event) => {
          const nextUrl = typeof event.payload?.url === "string" ? event.payload.url : "";
          if (!nextUrl) return;
          setBrowserSession((prev) => (prev ? { ...prev, url: nextUrl } : prev));
        });
        const uLoad = await listen<{ loading?: boolean }>("aiden-browser-loading", (event) => {
          const nextLoading = Boolean(event.payload?.loading);
          setBrowserSession((prev) => (prev ? { ...prev, loading: nextLoading } : prev));
        });
        const uClosed = await listen("aiden-browser-closed", () => {
          closeAidenBrowser();
        });
        const uExternal = await listen<{ url?: string }>("aiden-browser-open-external", (event) => {
          const extUrl = typeof event.payload?.url === "string" ? event.payload.url : "";
          if (extUrl) {
            openInAidenBrowser(extUrl, true);
          }
        });
        if (disposed) {
          uNav();
          uLoad();
          uClosed();
          uExternal();
        } else {
          unlistenNav = uNav;
          unlistenLoad = uLoad;
          unlistenClosed = uClosed;
          unlistenExternal = uExternal;
        }
      } catch {
        // Fallback outside Tauri
      }
    };
    attachBrowserEvents();

    return () => {
      disposed = true;
      window.removeEventListener(AIDEN_BROWSER_OPEN_EVENT, onOpenBrowserEvent as EventListener);
      if (unlistenNav) unlistenNav();
      if (unlistenLoad) unlistenLoad();
      if (unlistenClosed) unlistenClosed();
      if (unlistenExternal) unlistenExternal();
    };
  }, [openAidenBrowser, closeAidenBrowser]);

  // Sync state events from Tauri main process
  useEffect(() => {
    let disposed = false;
    let unlistenSync: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const unlisten = await listen<ChatPillSyncPayload>("chat-pill-sync", (event) => {
          const payload = event.payload;
          if (typeof payload.backendOnline === "boolean") {
            clearOfflineGraceTimer();
            setIsBackendOnline(payload.backendOnline);
          }
          if (typeof payload.isAwake === "boolean") {
            if (payload.isAwake) {
              clearOfflineGraceTimer();
              setIsBackendOnline(true);
            }
            setIsAwake(payload.isAwake);
          }
          if (typeof payload.isDarkMode === "boolean") {
            setIsDarkMode(payload.isDarkMode);
          }
          if (typeof payload.reply === "string") {
            setTurns([{ id: "sync-turn", userPrompt: null, assistantReply: payload.reply }]);
          }
        });
        if (disposed) {
          unlisten();
        } else {
          unlistenSync = unlisten;
        }
      } catch {
        // Fallback if running outside Tauri
      }
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlistenSync) unlistenSync();
    };
  }, [clearOfflineGraceTimer]);

  // Real-time backend WebSocket connection
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: number | null = null;

    const connectWebSocket = () => {
      try {
        const ws = new WebSocket("ws://127.0.0.1:8765");
        wsRef.current = ws;

        ws.onopen = () => {
          clearOfflineGraceTimer();
          try {
            ws.send(
              JSON.stringify({
                type: "ui_surface",
                pipMinimized:
                  !isAwakeRef.current ||
                  pipPhaseRef.current === "pip" ||
                  pipPhaseRef.current === "to-pip",
              })
            );
          } catch {
            // Ignore
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const msgType = data.type;

            if (msgType === "audio_meter") {
              setAudioMeter({
                level: Number(data.level || 0),
                bass: Number(data.bass || 0),
                mid: Number(data.mid || 0),
                high: Number(data.high || 0),
              });
            } else if (msgType === "voice_recording") {
              const rec = Boolean(data.isRecording);
              const wasRecording = isRecordingRef.current;
              isRecordingRef.current = rec;
              setIsRecording(rec);
              if (rec) {
                setActiveUiTag(null);
              } else if (wasRecording) {
                enterTurnPending(null, turnsRef.current.length > 0, false);
              } else {
                // Not recording and wasn't recording (e.g. idle arming) -> stay in listening mode
                setActiveUiTag(null);
              }
            } else if (msgType === "voice_status") {
              const status = String(data.status || "");
              if (status === "transcribing") {
                setActiveUiTag("Thinking");
              } else if (status === "armed" || status === "idle") {
                // When armed/idle and not streaming a reply, clear thinking tag so we stay in listening mode
                if (!isStreaming) {
                  setActiveUiTag(null);
                }
              }
            } else if (msgType === "voice_active") {
              const active = Boolean(data.active);
              handleToggleVoice(active, true);
            } else if (msgType === "voice_transcription") {
              const text = String(data.text || "").trim();
              if (text) {
                wasOriginVoiceRef.current = true;
                enterTurnPending(
                  turnsRef.current.length > 0 ? text : null,
                  turnsRef.current.length > 0,
                  true
                );
              }
            } else if (msgType === "state" || msgType === "state_change") {
              clearOfflineGraceTimer();
              if (typeof data.backendOnline === "boolean") {
                setIsBackendOnline(data.backendOnline);
              } else {
                setIsBackendOnline(true);
              }
              const nextAwake = Boolean(data.isAwake);
              setIsAwake(nextAwake);
            } else if (msgType === "ui_tag") {
              const tag = String(data.tag || "").trim();
              const connector = typeof data.connector === "string" ? data.connector : null;
              if (tag) {
                setActiveUiTag(tag);
                if (connector) {
                  setActiveConnector(connector);
                  currentTurnConnectorsRef.current.add(connector);
                } else {
                  const meta = resolveConnectorMeta(tag, null);
                  if (meta) {
                    currentTurnConnectorsRef.current.add(meta.key);
                  }
                }
              }
            } else if (msgType === "stream_start") {
              stopStreamRaf();
              stopPolishShuffle();
              targetTextRef.current = "";
              displayedLengthRef.current = 0;
              streamEndedRef.current = false;
              lastLineEmittedTimeRef.current = 0;
              setIsStreaming(true);

              // Seamless transition into random dynamic polish tag for final synthesis phase
              const initialPolishTag = getRandomPolishTag();
              setActiveUiTag(initialPolishTag);
              setActiveConnector(null);
              polishStartTimeRef.current = Date.now();

              // Rotate dynamic polish tag every 3 seconds during longer response generations
              let currentPolishTag = initialPolishTag;
              polishShuffleIntervalRef.current = window.setInterval(() => {
                const nextTag = getRandomPolishTag(currentPolishTag);
                currentPolishTag = nextTag;
                setActiveUiTag(nextTag);
              }, 3000);

              // Tracker: If originated from audio/mic mode, keep expanded UI in mic mode too
              if (wasOriginVoiceRef.current) {
                setIsVoiceActive(true);
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: "voice_arm" }));
                }
              }
            } else if (msgType === "stream_chunk") {
              setIsStreaming(true);
              if (typeof data.fullContent === "string") {
                targetTextRef.current = data.fullContent;
              } else if (typeof data.token === "string") {
                targetTextRef.current += data.token;
              }
            } else if (msgType === "stream_end") {
              stopStreamRaf();
              stopPolishShuffle();
              streamEndedRef.current = true;
              setIsStreaming(false);

              if (typeof data.fullContent === "string" && data.fullContent.length > 0) {
                targetTextRef.current = data.fullContent;
              } else if (typeof data.reply === "string" && data.reply.length > 0) {
                targetTextRef.current = data.reply;
              }
              const finalContent = targetTextRef.current.trim();

              const serverConnectors: string[] = Array.isArray(data.connectors) ? data.connectors : [];
              serverConnectors.forEach((c) => currentTurnConnectorsRef.current.add(c));
              const turnConnectorsList = Array.from(currentTurnConnectorsRef.current);
              currentTurnConnectorsRef.current.clear();

              if (wasOriginVoiceRef.current) {
                setIsVoiceActive(true);
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: "voice_arm" }));
                }
              }

              const newTurnId = "turn-" + Date.now();
              currentTurnIdRef.current = newTurnId;
              const pendingPrompt = followupThinkingPromptRef.current;
              const pendingImages = followupThinkingImagesRef.current;
              const turnEffort: "none" | "high" =
                data.reasoningEffort === "high" || pendingTurnEffortRef.current === "high"
                  ? "high"
                  : "none";
              const appendToExisting =
                Boolean(pendingPrompt) ||
                Boolean(pendingImages && pendingImages.length > 0 && turnsRef.current.length > 0) ||
                turnsRef.current.length > 0;
              const proactiveKind = typeof data.proactiveKind === "string" ? data.proactiveKind : null;
              const anchorPendingJobId = pendingAgyAnchorJobIdRef.current;
              if (anchorPendingJobId) {
                pendingAgyAnchorJobIdRef.current = null;
              }
              const anchorPendingFileJobId = pendingFileAgentAnchorJobIdRef.current;
              if (anchorPendingFileJobId) {
                pendingFileAgentAnchorJobIdRef.current = null;
              }

              const newTurn: ChatTurn = {
                id: newTurnId,
                userPrompt: pendingPrompt,
                userImages: pendingImages && pendingImages.length > 0 ? pendingImages : undefined,
                reasoningEffort: turnEffort,
                assistantReply: finalContent,
                isStreaming: false,
                connectors: turnConnectorsList.length > 0 ? turnConnectorsList : undefined,
                isProactive: Boolean(proactiveKind),
              };

              // Ensure natural polish dwell time (~300ms) while keeping follow-up bubble & in-stream
              // Polish tag visible beneath it until the completed reply swaps seamlessly in place
              const MIN_POLISH_DWELL_MS = 300;
              const elapsed = Date.now() - polishStartTimeRef.current;
              const delay = Math.max(0, MIN_POLISH_DWELL_MS - elapsed);

              if (polishTimerRef.current !== null) {
                window.clearTimeout(polishTimerRef.current);
                polishTimerRef.current = null;
              }

              polishTimerRef.current = window.setTimeout(() => {
                polishTimerRef.current = null;
                setProactiveTurnKind(null);
                if (proactiveKind && appendToExisting) {
                  setIsMaxHeight(true);
                }
                finalizeChatTurn(newTurn, appendToExisting, null);
                if (anchorPendingJobId) {
                  setAgyWorkJob((prev) =>
                    prev && prev.jobId === anchorPendingJobId
                      ? { ...prev, anchorTurnId: newTurnId }
                      : prev
                  );
                }
                if (anchorPendingFileJobId) {
                  setFileAgentJob((prev) =>
                    prev && prev.jobId === anchorPendingFileJobId
                      ? { ...prev, anchorTurnId: newTurnId }
                      : prev
                  );
                }
              }, delay);
            } else if (msgType === "proactive_turn_start") {
              const kind = typeof data.kind === "string" ? data.kind : "system";
              const tag = String(data.tag || "Thinking").trim() || "Thinking";
              const conn =
                typeof data.connector === "string" && data.connector
                  ? data.connector
                  : kind === "file_agent_done"
                  ? "file_system"
                  : "antigravity_work";
              setProactiveTurnKind(kind);
              setActiveUiTag(tag);
              setActiveConnector(conn);
              if (turnsRef.current.length > 0) {
                setIsMaxHeight(true);
              }
            } else if (
              msgType === "file_agent_start" ||
              msgType === "file_agent_update" ||
              msgType === "file_agent_done"
            ) {
              const jid = String(data.job_id || "");
              if (jid) {
                if (msgType === "file_agent_start") {
                  pendingFileAgentAnchorJobIdRef.current = jid;
                  setIsMaxHeight(true);
                }
                const rawCols: FileAgentTreeNode[][] = Array.isArray(data.columns) ? data.columns : [];
                const rawEdges: FileAgentTreeEdge[] = Array.isArray(data.edges) ? data.edges : [];
                const nextStatus: "scan" | "found" | "dead" | "stopped" =
                  data.status === "found" || data.status === "dead" || data.status === "stopped"
                    ? data.status
                    : "scan";
                setFileAgentJob((prev) => ({
                  jobId: jid,
                  goal: String(data.goal || prev?.goal || ""),
                  status: nextStatus,
                  activeAgents: Number(data.active_agents ?? 0),
                  foundPath: String(data.found_path || ""),
                  foundName: String(data.found_name || ""),
                  nearMiss:
                    data.near_miss && typeof data.near_miss === "object"
                      ? {
                          name: String(data.near_miss.name || ""),
                          path: String(data.near_miss.path || ""),
                        }
                      : null,
                  barTitle: String(data.bar_title || prev?.barTitle || ""),
                  barPath: String(data.bar_path || prev?.barPath || ""),
                  columns: rawCols,
                  edges: rawEdges,
                  anchorTurnId:
                    msgType === "file_agent_start"
                      ? null
                      : prev && prev.jobId === jid
                      ? prev.anchorTurnId ?? null
                      : null,
                }));
              }
            } else if (msgType === "agy_work_start") {
              const jid = String(data.job_id || "");
              if (jid) {
                pendingAgyAnchorJobIdRef.current = jid;
                const rawSteps = Array.isArray(data.steps) ? data.steps : [];
                setAgyWorkJob({
                  jobId: jid,
                  task: String(data.task || ""),
                  workingDir: typeof data.working_dir === "string" ? data.working_dir : undefined,
                  status: "running",
                  steps: rawSteps.map((s: { text?: string; status?: string }) => ({
                    text: String(s?.text || ""),
                    status: s?.status === "done" ? "done" : "active",
                  })),
                  elapsedSec: Number(data.elapsed_sec || 0),
                  cardDismissed: Boolean(data.card_dismissed),
                  anchorTurnId: null,
                });
              }
            } else if (msgType === "agy_work_step") {
              const jid = String(data.job_id || "");
              const rawSteps = Array.isArray(data.steps) ? data.steps : [];
              setAgyWorkJob((prev) => {
                if (!prev || (jid && prev.jobId !== jid)) return prev;
                return {
                  ...prev,
                  steps: rawSteps.map((s: { text?: string; status?: string }) => ({
                    text: String(s?.text || ""),
                    status: s?.status === "done" ? "done" : "active",
                  })),
                  elapsedSec: Number(data.elapsed_sec ?? prev.elapsedSec),
                };
              });
            } else if (msgType === "agy_work_done") {
              const jid = String(data.job_id || "");
              const nextStatus: "completed" | "failed" =
                data.status === "failed" ? "failed" : "completed";
              const rawSteps = Array.isArray(data.steps) ? data.steps : [];
              setAgyWorkJob((prev) => {
                if (!prev && !jid) return null;
                return {
                  jobId: jid || prev?.jobId || "",
                  task: prev?.task || "",
                  workingDir: prev?.workingDir,
                  status: nextStatus,
                  steps:
                    rawSteps.length > 0
                      ? rawSteps.map((s: { text?: string; status?: string }) => ({
                          text: String(s?.text || ""),
                          status: "done" as const,
                        }))
                      : (prev?.steps || []).map((s) => ({ ...s, status: "done" as const })),
                  elapsedSec: Number(data.elapsed_sec ?? prev?.elapsedSec ?? 0),
                  summary: typeof data.summary === "string" ? data.summary : prev?.summary,
                  cardDismissed:
                    typeof data.card_dismissed === "boolean"
                      ? data.card_dismissed
                      : Boolean(prev?.cardDismissed),
                  anchorTurnId: prev?.anchorTurnId ?? null,
                };
              });
              if (nextStatus === "completed") {
                setAgyDoneSeq((seq) => seq + 1);
              } else {
                setAgyFailedSeq((seq) => seq + 1);
              }
            } else if (msgType === "agy_work_hide") {
              const jid = String(data.job_id || "");
              pendingAgyAnchorJobIdRef.current = null;
              setAgyWorkJob((prev) => (!jid || !prev || prev.jobId === jid ? null : prev));
            } else if (msgType === "browser_open") {
              const targetUrl = String(data.url || "").trim();
              if (targetUrl) {
                const bw = typeof data.width === "number" ? data.width : 960;
                const bh = typeof data.height === "number" ? data.height : 600;
                openAidenBrowser(targetUrl, bw, bh);
              }
            } else if (msgType === "browser_navigate") {
              const action = String(data.action || "").trim();
              if (action) {
                invoke("browser_navigate_action", {
                  action,
                  url: typeof data.url === "string" ? data.url : undefined,
                }).catch(() => {});
              }
            } else if (msgType === "browser_scroll") {
              const direction = String(data.direction || "down").trim();
              const amount = typeof data.amount === "string" ? data.amount : "half";
              invoke("browser_scroll_action", { direction, amount }).catch(() => {});
            } else if (msgType === "browser_close") {
              closeAidenBrowser();
            } else if (msgType === "error") {
              stopStreamRaf();
              stopPolishShuffle();
              if (polishTimerRef.current !== null) {
                window.clearTimeout(polishTimerRef.current);
                polishTimerRef.current = null;
              }
              setIsStreaming(false);
              setProactiveTurnKind(null);
              const errText = String(data.message || "An unexpected error occurred.");
              const pendingPrompt = followupThinkingPromptRef.current;
              const pendingImages = followupThinkingImagesRef.current;

              const errorTurnId = "error-" + Date.now();
              currentTurnIdRef.current = null;
              finalizeChatTurn(
                {
                  id: errorTurnId,
                  userPrompt: pendingPrompt,
                  userImages: pendingImages && pendingImages.length > 0 ? pendingImages : undefined,
                  assistantReply: errText,
                  isStreaming: false,
                },
                Boolean(pendingPrompt) || turnsRef.current.length > 0,
                pendingPrompt ? null : "Error"
              );
            }
          } catch {
            // Ignore malformed frames
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (!isMounted) return;
          clearOfflineGraceTimer();
          offlineGraceTimerRef.current = window.setTimeout(() => {
            offlineGraceTimerRef.current = null;
            setIsBackendOnline(false);
            setIsAwake(false);
          }, 2200);
          reconnectTimer = window.setTimeout(connectWebSocket, 1200);
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {
            // Ignore
          }
        };
      } catch {
        if (isMounted) {
          reconnectTimer = window.setTimeout(connectWebSocket, 1500);
        }
      }
    };

    connectWebSocket();

    return () => {
      isMounted = false;
      stopStreamRaf();
      stopPolishShuffle();
      clearOfflineGraceTimer();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // Ignore
        }
      }
    };
  }, [clearOfflineGraceTimer]);

  const handleSendMessage = (
    msg: string,
    _isFollowup?: boolean,
    options?: SendMessageOptions
  ) => {
    stopStreamRaf();
    setIsVoiceActive(false);
    currentTurnConnectorsRef.current.clear();
    setActiveConnector(null);
    setIsExitingVoice(false);
    if (exitingVoiceTimerRef.current !== null) {
      window.clearTimeout(exitingVoiceTimerRef.current);
      exitingVoiceTimerRef.current = null;
    }
    setIsEnteringVoice(false);
    if (enteringVoiceTimerRef.current !== null) {
      window.clearTimeout(enteringVoiceTimerRef.current);
      enteringVoiceTimerRef.current = null;
    }
    targetTextRef.current = "";
    displayedLengthRef.current = 0;
    streamEndedRef.current = false;
    lastLineEmittedTimeRef.current = 0;
    setIsStreaming(false);

    const isFollowup = Boolean(_isFollowup || turnsRef.current.length > 0);
    const images = options?.images && options.images.length > 0 ? options.images : undefined;
    const reasoningEffort: "none" | "high" = options?.reasoningEffort === "high" ? "high" : "none";
    const promptForBubble = isFollowup && msg.trim().length > 0 ? msg : null;

    enterTurnPending(promptForBubble, isFollowup, true, images, reasoningEffort);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "command",
          text: msg,
          images: images || [],
          reasoningEffort,
        })
      );
    } else {
      const offlineMsg = "Aiden's backend is not running. Boot up Aiden from the Control Panel first.";
      finalizeChatTurn(
        {
          id: "offline-" + Date.now(),
          userPrompt: promptForBubble,
          userImages: images,
          reasoningEffort,
          assistantReply: offlineMsg,
          isStreaming: false,
        },
        isFollowup,
        isFollowup ? null : "Offline"
      );
    }
  };

  const handleHardwareChange = useCallback((action: "volume" | "brightness", level?: number, muted?: boolean) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "hardware_control",
          action,
          level,
          muted,
        })
      );
    }
  }, []);

  const handleSpotifyPlay = useCallback((spotifyId: string, itemType: "track" | "album" | "artist" | "playlist") => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "spotify_play",
          spotifyId,
          itemType,
        })
      );
    }
  }, []);

  const handleDismissAgyCard = useCallback((jobId: string) => {
    setAgyWorkJob((prev) =>
      prev && prev.jobId === jobId ? { ...prev, cardDismissed: true } : prev
    );
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "agy_card_dismissed",
          job_id: jobId,
        })
      );
    }
  }, []);

  const handleStopAgyTask = useCallback((jobId: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "agy_stop_task",
          job_id: jobId,
        })
      );
    }
  }, []);

  const handleStopFileAgent = useCallback((jobId: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "file_agent_stop",
          job_id: jobId,
        })
      );
    }
  }, []);

  const handleOpenFilePath = useCallback((path: string, mode: "open" | "reveal") => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "file_open_path",
          path,
          mode,
        })
      );
    }
  }, []);

  const handleA2UIAction = useCallback((event: A2UIActionEvent) => {
    const bubbleLabel = event.label && event.label.trim() ? event.label.trim() : null;
    enterTurnPending(bubbleLabel, true, true);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "a2ui_action",
          userAction: event,
        })
      );
    } else {
      finalizeChatTurn(
        {
          id: "offline-a2ui-" + Date.now(),
          userPrompt: bubbleLabel,
          assistantReply: "Aiden's backend is not running. Boot up Aiden from the Control Panel first.",
          isStreaming: false,
        },
        true,
        null
      );
    }
  }, []);

  return (
    <div className="chat-pill-desktop-window">
      <ChatPill
        contentRef={contentRef}
        isAwake={isAwake}
        isBackendOnline={isBackendOnline}
        isDarkMode={isDarkMode}
        isMaxHeight={isMaxHeight}
        turns={turns}
        followupThinkingPrompt={followupThinkingPrompt}
        followupThinkingImages={followupThinkingImages}
        activeUiTag={activeUiTag}
        activeConnector={activeConnector}
        isStreaming={isStreaming}
        onClearResponse={() => resetReplyState()}
        onToggleSleep={() => {
          const nextAwake = !isAwake;
          setIsAwake(nextAwake);
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: nextAwake ? "wake" : "sleep" }));
          }
        }}
        onSendMessage={handleSendMessage}
        onHardwareChange={handleHardwareChange}
        onSpotifyPlay={handleSpotifyPlay}
        isVoiceActive={isVoiceActive}
        onToggleVoice={handleToggleVoice}
        isExitingVoice={isExitingVoice}
        isEnteringVoice={isEnteringVoice}
        audioMeter={audioMeter}
        isRecording={isRecording}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
        onHeightChange={handlePillHeightChange}
        pipPhase={pipPhase}
        onMinimizeToPip={handleMinimizeToPip}
        onMaximizeFromPip={handleSquareActivate}
        winMinimizeRef={winMinimizeActionRef}
        agyWorkJob={agyWorkJob}
        agyDoneSeq={agyDoneSeq}
        agyFailedSeq={agyFailedSeq}
        proactiveTurnKind={proactiveTurnKind}
        onDismissAgyCard={handleDismissAgyCard}
        onStopAgyTask={handleStopAgyTask}
        fileAgentJob={fileAgentJob}
        onStopFileAgent={handleStopFileAgent}
        onOpenFilePath={handleOpenFilePath}
        onA2UIAction={handleA2UIAction}
        browserSession={browserSession ? { url: browserSession.url, loading: browserSession.loading } : null}
        onCloseBrowser={closeAidenBrowser}
      />
    </div>
  );
};
