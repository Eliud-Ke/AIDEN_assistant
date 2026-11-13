import React, { useState } from "react";

export interface SpotifyAlbumItem {
  id: string;
  name: string;
  artists: string;
  totalTracks?: number;
  year?: string;
  image?: string;
  spotifyUrl?: string;
}

export interface SpotifyAlbumsCardData {
  query?: string;
  albums: SpotifyAlbumItem[];
  onPlayItem?: (id: string, type: "album", title?: string) => void;
}

export const SpotifyAlbumsCard: React.FC<SpotifyAlbumsCardData> = ({
  albums,
  onPlayItem,
}) => {
  const [playingId, setPlayingId] = useState<string | null>(null);

  if (!albums || albums.length === 0) return null;

  const topAlbum = albums[0];
  const otherAlbums = albums.slice(1, 5);

  const handlePlayAlbum = (e: React.MouseEvent, album: SpotifyAlbumItem) => {
    e.stopPropagation();
    if (!album.id) return;
    setPlayingId(album.id);
    onPlayItem?.(album.id, "album", `${album.name} ${album.artists}`);
  };

  return (
    <div className="spotify-result-card">
      {/* Top Bar */}
      <div className="card-top-bar">
        <div className="spotify-pill-tag">
          <svg className="spotify-pill-icon" viewBox="0 0 24 24">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.495 17.306c-.216.353-.675.466-1.028.25-2.817-1.721-6.362-2.111-10.539-1.157-.404.093-.808-.16-.901-.564-.093-.404.16-.808.564-.901 4.576-1.045 8.5-1.002 11.654 1.344.353.216.466.675.25 1.028zm1.467-3.26c-.272.443-.852.583-1.295.311-3.224-1.982-8.139-2.555-11.952-1.398-.499.151-1.028-.135-1.179-.634-.151-.499.135-1.028.634-1.179 4.359-1.323 9.776-.682 13.481 1.595.443.272.583.852.311 1.295zm.126-3.41c-3.866-2.296-10.245-2.508-13.935-1.387-.594.18-1.226-.156-1.406-.75-.18-.594.156-1.226.75-1.406 4.238-1.286 11.278-1.036 15.733 1.609.534.317.708 1.011.391 1.545-.317.534-1.011.708-1.545.391z" />
          </svg>
          <span>Spotify Albums</span>
        </div>
      </div>

      {/* Top Result (Best Album Match with Vinyl Sheen & Prominent Green Play Button) */}
      <div
        className={`top-match-hero ${playingId === topAlbum.id ? "is-playing" : ""}`}
        onClick={(e) => handlePlayAlbum(e, topAlbum)}
        title={`Play Album ${topAlbum.name} by ${topAlbum.artists}`}
      >
        <div className="hero-left-group">
          <div className="hero-artwork-wrap album-wrap">
            {topAlbum.image ? (
              <img
                className="hero-artwork"
                src={topAlbum.image}
                alt={topAlbum.name}
              />
            ) : (
              <div className="hero-artwork-placeholder" />
            )}
          </div>
          <div className="hero-info">
            <div className="hero-title-row">
              <span className="hero-title">{topAlbum.name}</span>
            </div>
            <div className="hero-subtitle">
              <span>
                Album • {topAlbum.artists}
                {topAlbum.year ? ` • ${topAlbum.year}` : ""}
                {topAlbum.totalTracks ? ` • ${topAlbum.totalTracks} tracks` : ""}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className={`hero-play-btn ${playingId === topAlbum.id ? "is-playing" : ""}`}
          title={`Play Album ${topAlbum.name}`}
          onClick={(e) => handlePlayAlbum(e, topAlbum)}
        >
          <svg viewBox="0 0 24 24">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
      </div>

      {/* Other Matching Albums */}
      {otherAlbums.length > 0 && (
        <>
          <div className="matches-section-label">Other Matching Albums</div>
          <div className="tracks-list-container">
            {otherAlbums.map((alb) => (
              <div
                key={alb.id}
                className={`track-row-item ${playingId === alb.id ? "is-playing" : ""}`}
                onClick={(e) => handlePlayAlbum(e, alb)}
                title={`Play Album ${alb.name} by ${alb.artists}`}
              >
                <div className="track-row-left">
                  <div className="track-thumb-wrap">
                    {alb.image ? (
                      <img
                        className="track-thumb"
                        src={alb.image}
                        alt={alb.name}
                      />
                    ) : (
                      <div className="track-thumb-placeholder" />
                    )}
                    <div className="thumb-play-overlay">
                      <svg viewBox="0 0 24 24">
                        <polygon points="6 4 18 12 6 20 6 4" />
                      </svg>
                    </div>
                  </div>
                  <div className="track-meta">
                    <div className="track-name">{alb.name}</div>
                    <div className="track-artist">
                      <span>
                        {alb.artists}
                        {alb.totalTracks ? ` • ${alb.totalTracks} tracks` : ""}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="track-row-right">
                  {alb.year && <span className="type-pill">{alb.year}</span>}
                  <span className="track-duration">Album</span>
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
