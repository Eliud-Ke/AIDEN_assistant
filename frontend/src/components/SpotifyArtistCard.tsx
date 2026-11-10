import React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface SpotifyArtistCardData {
  artistId: string;
  name: string;
  image?: string;
  verified?: boolean;
  monthlyListeners?: string;
  followers?: string;
  genres?: string;
  popularity?: number;
  spotifyUrl?: string;
  onPlayItem?: (id: string, type: "artist", title?: string) => void;
}

export const SpotifyArtistCard: React.FC<SpotifyArtistCardData> = ({
  artistId,
  name,
  image,
  verified = true,
  monthlyListeners,
  followers,
  genres,
  spotifyUrl,
  onPlayItem,
}) => {
  const handleOpenSpotify = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = spotifyUrl || (artistId ? `https://open.spotify.com/artist/${artistId}` : "");
    if (!url) return;
    try {
      openUrl(url).catch(() => window.open(url, "_blank"));
    } catch {
      window.open(url, "_blank");
    }
  };

  const handlePlayArtist = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPlayItem?.(artistId, "artist", `${name} Radio`);
  };

  const listenersText = monthlyListeners || followers || "Popular on Spotify";
  const displayGenres = genres && genres !== "Music" ? genres : "";

  // Multi-axis compound glass vignette:
  // 1. Horizontal vignette (left-to-right) protects artist typography & metadata
  // 2. Vertical vignette (bottom-to-top) cleanly grounds the bottom with 100% solid obsidian to prevent any light bleed
  const cardStyle: React.CSSProperties = image
    ? {
        backgroundImage: [
          `linear-gradient(to right, rgba(12, 12, 12, 0.94) 0%, rgba(12, 12, 12, 0.78) 38%, rgba(12, 12, 12, 0.22) 72%, rgba(12, 12, 12, 0.45) 100%)`,
          `linear-gradient(to top, rgba(12, 12, 12, 1) 0%, rgba(12, 12, 12, 0.98) 18%, rgba(12, 12, 12, 0.55) 55%, rgba(12, 12, 12, 0.15) 85%, transparent 100%)`,
          `url("${image}")`,
        ].join(", "),
        backgroundSize: "cover",
        backgroundPosition: "center 20%",
        backgroundRepeat: "no-repeat",
      }
    : {};

  return (
    <div
      className="spotify-artist-card"
      style={cardStyle}
      onClick={handlePlayArtist}
      title={`Stream ${name} on Spotify`}
    >
      {/* Top Controls Row */}
      <div className="artist-card-top">
        <div className="spotify-pill-tag">
          <svg className="spotify-pill-icon" viewBox="0 0 24 24">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.495 17.306c-.216.353-.675.466-1.028.25-2.817-1.721-6.362-2.111-10.539-1.157-.404.093-.808-.16-.901-.564-.093-.404.16-.808.564-.901 4.576-1.045 8.5-1.002 11.654 1.344.353.216.466.675.25 1.028zm1.467-3.26c-.272.443-.852.583-1.295.311-3.224-1.982-8.139-2.555-11.952-1.398-.499.151-1.028-.135-1.179-.634-.151-.499.135-1.028.634-1.179 4.359-1.323 9.776-.682 13.481 1.595.443.272.583.852.311 1.295zm.126-3.41c-3.866-2.296-10.245-2.508-13.935-1.387-.594.18-1.226-.156-1.406-.75-.18-.594.156-1.226.75-1.406 4.238-1.286 11.278-1.036 15.733 1.609.534.317.708 1.011.391 1.545-.317.534-1.011.708-1.545.391z" />
          </svg>
          <span>Spotify Artist</span>
        </div>

        <button
          type="button"
          className="artist-open-link"
          title="Open in Spotify"
          onClick={handleOpenSpotify}
        >
          <svg viewBox="0 0 24 24">
            <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
          </svg>
        </button>
      </div>

      {/* Bottom Profile & Play Action Row */}
      <div className="artist-card-bottom">
        <div className="artist-meta-group">
          {verified && (
            <div className="artist-verified-row">
              <svg className="verified-icon" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
              <span>Verified Artist</span>
            </div>
          )}
          <div className="artist-name-heading" title={name}>
            {name}
          </div>
          <div className="artist-sub-info">
            <span>{listenersText}</span>
            {displayGenres && (
              <>
                <span className="artist-sub-dot">•</span>
                <span>{displayGenres}</span>
              </>
            )}
          </div>
        </div>

        {/* Big Green Play Button */}
        <button
          type="button"
          className="artist-play-btn"
          title={`Stream ${name} Radio`}
          onClick={handlePlayArtist}
        >
          <svg viewBox="0 0 24 24">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
      </div>
    </div>
  );
};
