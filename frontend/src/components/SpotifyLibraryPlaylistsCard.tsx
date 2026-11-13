import React, { useState } from "react";
import { SpotifyPlaylistItem } from "./SpotifyPlaylistsCard";

export interface SpotifyLibraryPlaylistsCardData {
  mode: "search" | "list";
  query?: string;
  total?: number;
  playlists: SpotifyPlaylistItem[];
}

interface SpotifyLibraryPlaylistsCardProps extends SpotifyLibraryPlaylistsCardData {
  onPlayItem?: (
    spotifyId: string,
    itemType: "track" | "album" | "artist" | "playlist",
    title: string
  ) => void;
}

const formatOwnership = (pl: SpotifyPlaylistItem): string => {
  if (pl.isOwner === true) return "Made by you";
  if (pl.isOwner === false) return pl.owner ? `Saved • By ${pl.owner}` : "Saved playlist";
  return pl.owner ? `By ${pl.owner}` : "Spotify Playlist";
};

export const SpotifyLibraryPlaylistsCard: React.FC<SpotifyLibraryPlaylistsCardProps> = ({
  mode = "list",
  total,
  playlists,
  onPlayItem,
}) => {
  const [playingId, setPlayingId] = useState<string | null>(null);

  const list = Array.isArray(playlists) ? playlists.filter((p) => p && p.id) : [];
  if (list.length === 0) return null;

  const isSearchMode = mode === "search";
  const topPlaylist = list[0];
  const rowsToDisplay = isSearchMode ? list.slice(1) : list;
  const displayTotal = typeof total === "number" && total > 0 ? total : list.length;

  const handlePlayPlaylist = (
    e: React.MouseEvent,
    playlist: SpotifyPlaylistItem
  ) => {
    e.stopPropagation();
    setPlayingId(playlist.id);
    if (onPlayItem) {
      onPlayItem(playlist.id, "playlist", playlist.name);
    }
  };

  return (
    <div className="spotify-result-card">
      {/* Top Bar */}
      <div className="card-top-bar">
        <div className="spotify-pill-tag">
          <svg className="spotify-pill-icon" viewBox="0 0 24 24">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
          <span>{isSearchMode ? "Your Library" : "Your Playlists"}</span>
        </div>

        <div className="top-bar-right">
          {!isSearchMode && (
            <span className="library-count-pill">
              {displayTotal} {displayTotal === 1 ? "playlist" : "playlists"}
            </span>
          )}

          <div className="shuffle-default-chip" title="Starts shuffled by default">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 3 21 3 21 8" />
              <line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" />
              <line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
            <span>Shuffle</span>
          </div>
        </div>
      </div>

      {/* Top Match Hero (Search My Playlist Mode Only) */}
      {isSearchMode && (
        <div
          className={`top-match-hero ${playingId === topPlaylist.id ? "is-playing" : ""}`}
          onClick={(e) => handlePlayPlaylist(e, topPlaylist)}
          title={`Shuffle play "${topPlaylist.name}" on Spotify`}
        >
          <div className="hero-left-group">
            <div className="hero-artwork-wrap album-wrap">
              {topPlaylist.image ? (
                <img
                  src={topPlaylist.image}
                  alt={topPlaylist.name}
                  className="hero-artwork"
                  loading="lazy"
                />
              ) : (
                <div className="hero-artwork-placeholder" />
              )}
            </div>
            <div className="hero-info">
              <div className="hero-title-row">
                <span className="hero-title">{topPlaylist.name}</span>
              </div>
              <div className="hero-subtitle">
                Playlist • {formatOwnership(topPlaylist)}
                {topPlaylist.totalTracks
                  ? ` • ${topPlaylist.totalTracks} ${topPlaylist.totalTracks === 1 ? "song" : "songs"}`
                  : ""}
              </div>
            </div>
          </div>

          <button
            className={`hero-play-btn ${playingId === topPlaylist.id ? "is-playing" : ""}`}
            onClick={(e) => handlePlayPlaylist(e, topPlaylist)}
            title="Shuffle Play Playlist in Spotify"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          </button>
        </div>
      )}

      {/* Scrollable Library Playlist List */}
      {rowsToDisplay.length > 0 && (
        <>
          <div className="matches-section-label">
            {isSearchMode ? "Other Playlists in Your Library" : "Created & Saved Playlists"}
          </div>
          <div className={`playlist-scroll-area ${isSearchMode ? "search-others" : "library-full"}`}>
            {rowsToDisplay.map((pl) => (
              <div
                key={pl.id}
                className={`track-row-item ${playingId === pl.id ? "is-playing" : ""}`}
                onClick={(e) => handlePlayPlaylist(e, pl)}
                title={`Shuffle play "${pl.name}"`}
              >
                <div className="track-row-left">
                  <div className="track-thumb-wrap">
                    {pl.image ? (
                      <img
                        src={pl.image}
                        alt={pl.name}
                        className="track-thumb"
                        loading="lazy"
                      />
                    ) : (
                      <div className="track-thumb-placeholder" />
                    )}
                    <div className="thumb-play-overlay">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffff">
                        <polygon points="7,5 19,12 7,19" />
                      </svg>
                    </div>
                  </div>
                  <div className="track-meta">
                    <div className="track-name">{pl.name}</div>
                    <div className="track-artist">{formatOwnership(pl)}</div>
                  </div>
                </div>

                <div className="track-row-right">
                  {typeof pl.totalTracks === "number" && pl.totalTracks > 0 && (
                    <span className="type-pill">
                      {pl.totalTracks} {pl.totalTracks === 1 ? "track" : "tracks"}
                    </span>
                  )}
                  <div className="sound-equalizer">
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
