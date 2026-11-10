import React, { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface SpotifyArtistTrackItem {
  id: string;
  name: string;
  artists: string;
  duration: string;
  explicit?: boolean;
  albumName?: string;
  albumImage?: string;
}

export interface SpotifyArtistAlbumItem {
  id: string;
  name: string;
  year: string;
  totalTracks?: number;
  image?: string;
  albumType?: string;
}

export interface SpotifyArtistCardData {
  artistId: string;
  name: string;
  image?: string;
  verified?: boolean;
  monthlyListeners?: string;
  followers?: string;
  genres?: string;
  topTracks?: SpotifyArtistTrackItem[];
  albums?: SpotifyArtistAlbumItem[];
  onPlayItem?: (id: string, type: "artist" | "track" | "album", title?: string) => void;
}

export const SpotifyArtistCard: React.FC<SpotifyArtistCardData> = ({
  artistId,
  name,
  image,
  verified = true,
  monthlyListeners,
  topTracks = [],
  albums = [],
  onPlayItem,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleOpenSpotify = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!artistId) return;
    const url = `https://open.spotify.com/artist/${artistId}`;
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

  const visibleTracks = topTracks.slice(0, 2);
  const drawerTracks = topTracks.slice(2, 5);
  const displayAlbums = albums.slice(0, 2);

  return (
    <div className={`spotify-spotlight-card ${isExpanded ? "expanded" : ""}`}>
      {/* 1. CINEMATIC ARTIST HERO BANNER */}
      <div className="spotlight-hero-banner">
        {image && (
          <img
            className="spotlight-hero-bg"
            src={image}
            alt={name}
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = "none";
            }}
          />
        )}
        <div className="spotlight-hero-vignette" />

        {/* Top Badges inside Hero */}
        <div className="spotlight-hero-top">
          <div className="spotify-pill-tag">
            <svg className="spotify-pill-icon" viewBox="0 0 24 24">
              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.495 17.306c-.216.353-.675.466-1.028.25-2.817-1.721-6.362-2.111-10.539-1.157-.404.093-.808-.16-.901-.564-.093-.404.16-.808.564-.901 4.576-1.045 8.5-1.002 11.654 1.344.353.216.466.675.25 1.028zm1.467-3.26c-.272.443-.852.583-1.295.311-3.224-1.982-8.139-2.555-11.952-1.398-.499.151-1.028-.135-1.179-.634-.151-.499.135-1.028.634-1.179 4.359-1.323 9.776-.682 13.481 1.595.443.272.583.852.311 1.295zm.126-3.41c-3.866-2.296-10.245-2.508-13.935-1.387-.594.18-1.226-.156-1.406-.75-.18-.594.156-1.226.75-1.406 4.238-1.286 11.278-1.036 15.733 1.609.534.317.708 1.011.391 1.545-.317.534-1.011.708-1.545.391z" />
            </svg>
            <span>Spotify Artist</span>
          </div>

          <button
            type="button"
            className="spotlight-share-btn"
            title="Open in Spotify"
            onClick={handleOpenSpotify}
          >
            <svg viewBox="0 0 24 24">
              <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
            </svg>
          </button>
        </div>

        {/* Bottom Row inside Hero */}
        <div className="spotlight-hero-bottom">
          <div className="artist-title-group">
            {verified && (
              <div className="artist-verified-row">
                <svg className="verified-badge-icon" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                </svg>
                <span>Verified Artist</span>
              </div>
            )}
            <div className="artist-hero-name" title={name}>
              {name}
            </div>
            <div className="artist-listeners-text">
              {monthlyListeners || "Popular on Spotify"}
            </div>
          </div>

          {/* Giant Floating Green Play FAB */}
          <button
            type="button"
            className="spotlight-play-fab"
            title={`Play ${name} Radio`}
            onClick={handlePlayArtist}
          >
            <svg viewBox="0 0 24 24">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2. CARD CONTENT BODY */}
      <div className="spotlight-content-body">
        {/* TOP 2 ALWAYS-VISIBLE POPULAR TRACKS */}
        {visibleTracks.length > 0 && (
          <div>
            <div className="section-title">
              <span>Popular</span>
              <span className="section-badge-pill">Top Hits</span>
            </div>

            <div className="spotlight-tracks-list">
              {visibleTracks.map((track, idx) => (
                <div
                  key={track.id || idx}
                  className="spotlight-track-row"
                  onClick={() => onPlayItem?.(track.id, "track", track.name)}
                  title={`Play "${track.name}"`}
                >
                  <div className="track-left-group">
                    <div className="track-index-num">{idx + 1}</div>
                    <div className="track-album-thumb">
                      {track.albumImage ? (
                        <img
                          className="track-album-img"
                          src={track.albumImage}
                          alt={track.albumName || track.name}
                        />
                      ) : (
                        <div className="track-album-placeholder" />
                      )}
                    </div>
                    <div className="track-meta-group">
                      <div className="track-title">{track.name}</div>
                      <div className="track-artist-sub">
                        {track.explicit && <span className="explicit-pill">E</span>}
                        <span>{track.artists || name}</span>
                      </div>
                    </div>
                  </div>
                  <div className="track-right-group">
                    <span className="track-duration">{track.duration}</span>
                    <svg className="track-row-play-icon" viewBox="0 0 24 24">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* DYNAMIC EXPANDABLE DRAWER (Tracks 3-5 + Latest Releases) */}
        <div className="spotlight-expandable-drawer">
          <div className="spotlight-expandable-drawer-inner">
            {/* Tracks 3, 4, 5 */}
            {drawerTracks.length > 0 && (
              <div className="spotlight-tracks-list" style={{ paddingTop: 2 }}>
                {drawerTracks.map((track, idx) => (
                  <div
                    key={track.id || idx + 2}
                    className="spotlight-track-row"
                    onClick={() => onPlayItem?.(track.id, "track", track.name)}
                    title={`Play "${track.name}"`}
                  >
                    <div className="track-left-group">
                      <div className="track-index-num">{idx + 3}</div>
                      <div className="track-album-thumb">
                        {track.albumImage ? (
                          <img
                            className="track-album-img"
                            src={track.albumImage}
                            alt={track.albumName || track.name}
                          />
                        ) : (
                          <div className="track-album-placeholder" />
                        )}
                      </div>
                      <div className="track-meta-group">
                        <div className="track-title">{track.name}</div>
                        <div className="track-artist-sub">
                          {track.explicit && <span className="explicit-pill">E</span>}
                          <span>{track.artists || name}</span>
                        </div>
                      </div>
                    </div>
                    <div className="track-right-group">
                      <span className="track-duration">{track.duration}</span>
                      <svg className="track-row-play-icon" viewBox="0 0 24 24">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* LATEST RELEASES / ALBUMS (2 TILES) */}
            {displayAlbums.length > 0 && (
              <div>
                <div className="section-title">
                  <span>Latest Releases</span>
                  <span className="section-badge-pill">Albums</span>
                </div>

                <div className="spotlight-albums-grid">
                  {displayAlbums.map((album, idx) => (
                    <div
                      key={album.id || idx}
                      className="spotlight-album-card"
                      onClick={() => onPlayItem?.(album.id, "album", album.name)}
                      title={`Play album "${album.name}"`}
                    >
                      <div className="album-sleeve-thumb">
                        {album.image ? (
                          <img
                            className="album-sleeve-img"
                            src={album.image}
                            alt={album.name}
                          />
                        ) : (
                          <div className="album-sleeve-placeholder" />
                        )}
                      </div>
                      <div className="album-text-meta">
                        <div className="album-name" title={album.name}>
                          {album.name}
                        </div>
                        <div className="album-year-sub">
                          <span className="album-type-badge">
                            {album.albumType || "Album"}
                          </span>
                          {album.year && <span>{album.year}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. SLEEK DOWNWARD CHEVRON EXPAND / COLLAPSE BUTTON BAR */}
      <button
        type="button"
        className="spotlight-chevron-bar"
        onClick={() => setIsExpanded((prev) => !prev)}
        title={isExpanded ? "Collapse Details" : "Show Full Discography & Hits"}
      >
        <div className="chevron-icon-pill">
          <svg viewBox="0 0 24 24">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>
    </div>
  );
};
