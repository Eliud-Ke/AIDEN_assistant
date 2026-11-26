import React, { useState, useCallback, useEffect } from "react";
import { openInAidenBrowser } from "../utils/aidenBrowser";
import "./YouTubeCard.css";

export interface YouTubeVideoItem {
  videoId: string;
  title: string;
  channel: string;
  duration?: string;
  views?: string;
  published?: string;
  description?: string;
  thumb: string;
  url: string;
}

export interface YouTubeCardData {
  mode?: "search" | "suggestion";
  query?: string;
  videos: YouTubeVideoItem[];
}

interface YouTubeCardProps {
  data: YouTubeCardData;
  onLayoutChange?: () => void;
}

function getSafeWatchUrl(video: YouTubeVideoItem): string {
  const raw = (video.url || "").trim();
  if (/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(raw)) {
    return raw;
  }
  const cleanId = (video.videoId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleanId ? `https://www.youtube.com/watch?v=${cleanId}` : "https://www.youtube.com";
}

function getSafeThumbUrl(video: YouTubeVideoItem): string {
  const raw = (video.thumb || "").trim();
  if (/^https:\/\/(i\d?\.ytimg\.com|img\.youtube\.com|yt3\.ggpht\.com)\//i.test(raw)) {
    return raw;
  }
  const cleanId = (video.videoId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleanId ? `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg` : "";
}

export const YouTubeLoadingSkeleton: React.FC = () => (
  <div className="yt-tray" aria-label="Loading YouTube video">
    <div className="yt-stage-viewport">
      <div className="yt-dots-nav" style={{ pointerEvents: "none" }}>
        <div className="yt-skel-box" style={{ width: 32, height: 16, borderRadius: 999 }} />
        <div className="yt-skel-box" style={{ width: 16, height: 16, borderRadius: "50%" }} />
        <div className="yt-skel-box" style={{ width: 16, height: 16, borderRadius: "50%" }} />
        <div className="yt-skel-box" style={{ width: 16, height: 16, borderRadius: "50%" }} />
      </div>
      <div className="yt-skel-box" style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 0 }} />
    </div>
    <div className="yt-hero-content">
      <div className="yt-skel-box" style={{ width: "88%", height: 15 }} />
      <div className="yt-skel-box" style={{ width: "54%", height: 11 }} />
      <div className="yt-skel-box" style={{ width: "94%", height: 11 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <div className="yt-skel-box" style={{ flex: 1, height: 34, borderRadius: 11 }} />
        <div className="yt-skel-box" style={{ width: 88, height: 34, borderRadius: 11 }} />
      </div>
    </div>
  </div>
);

export const YouTubeCard: React.FC<YouTubeCardProps> = ({ data, onLayoutChange }) => {
  const videos = (data.videos || []).slice(0, 4);
  const isCarousel = videos.length > 1;

  const [activeIdx, setActiveIdx] = useState(0);
  const [slideDir, setSlideDir] = useState<"none" | "next" | "prev">("none");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (activeIdx >= videos.length) {
      setActiveIdx(0);
      setSlideDir("none");
    }
  }, [activeIdx, videos.length]);

  const handleSelectIdx = useCallback(
    (nextIndex: number) => {
      if (!isCarousel) return;
      const clamped = (nextIndex + videos.length) % videos.length;
      if (clamped === activeIdx) return;
      setSlideDir(clamped > activeIdx ? "next" : "prev");
      setActiveIdx(clamped);
      onLayoutChange?.();
    },
    [activeIdx, isCarousel, videos.length, onLayoutChange]
  );

  const handleOpenVideo = useCallback((video: YouTubeVideoItem, forceExternal = false) => {
    const targetUrl = getSafeWatchUrl(video);
    openInAidenBrowser(targetUrl, forceExternal);
  }, []);

  const handleCopyLink = useCallback((e: React.MouseEvent, video: YouTubeVideoItem) => {
    e.stopPropagation();
    const targetUrl = getSafeWatchUrl(video);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(targetUrl).catch(() => {});
    }
    const key = video.videoId || targetUrl;
    setCopiedId(key);
    window.setTimeout(() => {
      setCopiedId((curr) => (curr === key ? null : curr));
    }, 1300);
  }, []);

  if (videos.length === 0) return null;

  const video = videos[activeIdx] || videos[0];
  const thumbUrl = getSafeThumbUrl(video);
  const isCopied = copiedId === (video.videoId || getSafeWatchUrl(video));
  const animCls =
    slideDir === "next" ? "anim-next" : slideDir === "prev" ? "anim-prev" : "";

  return (
    <div className="yt-tray" onClick={(e) => e.stopPropagation()}>
      <div className="yt-stage-viewport">
        {isCarousel && (
          <div className="yt-dots-nav" role="tablist" aria-label={`Choose video 1 to ${videos.length}`}>
            {videos.map((item, idx) => (
              <button
                key={item.videoId || idx}
                type="button"
                role="tab"
                aria-selected={idx === activeIdx}
                className={`yt-dot-btn ${idx === activeIdx ? "active" : ""}`}
                title={`${idx + 1}. ${item.title}`}
                aria-label={`Video ${idx + 1}: ${item.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelectIdx(idx);
                }}
              >
                {idx + 1}
              </button>
            ))}
          </div>
        )}

        <div key={`${video.videoId || activeIdx}-${activeIdx}`} className={`yt-hero-slide ${animCls}`}>
          <div
            className="yt-hero-media"
            role="button"
            tabIndex={0}
            aria-label={`Watch ${video.title} on YouTube`}
            onClick={() => handleOpenVideo(video)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleOpenVideo(video);
              }
            }}
          >
            {thumbUrl && (
              <img
                className="yt-thumb-img"
                src={thumbUrl}
                alt={video.title}
                loading="lazy"
                onLoad={() => onLayoutChange?.()}
              />
            )}

            {video.duration && <span className="yt-duration-pill">{video.duration}</span>}

            <div className="yt-play-hover" aria-hidden="true">
              <div className="yt-play-circle">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="#ffffff">
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
              </div>
            </div>

            {isCarousel && (
              <>
                <button
                  type="button"
                  className="yt-edge-arrow left"
                  title="Previous video"
                  aria-label="Previous video"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectIdx(activeIdx - 1);
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="yt-edge-arrow right"
                  title="Next video"
                  aria-label="Next video"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectIdx(activeIdx + 1);
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              </>
            )}
          </div>

          <div className="yt-hero-content">
            <h3 className="yt-hero-title">{video.title}</h3>
            <div className="yt-hero-stats">
              <strong>{video.channel}</strong>
              {video.views && (
                <>
                  <span>·</span>
                  <span>{video.views}</span>
                </>
              )}
              {video.published && (
                <>
                  <span>·</span>
                  <span>{video.published}</span>
                </>
              )}
            </div>
            {video.description && <p className="yt-hero-desc">{video.description}</p>}
            <div className="yt-hero-actions">
              <button
                type="button"
                className="yt-btn-primary"
                onClick={() => handleOpenVideo(video)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#ffffff" aria-hidden="true">
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
                <span>Watch on YouTube</span>
              </button>
              <button
                type="button"
                className="yt-btn-ghost"
                onClick={(e) => handleCopyLink(e, video)}
              >
                {isCopied ? "✓ Copied" : "Copy Link"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
