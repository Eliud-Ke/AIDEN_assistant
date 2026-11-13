import React, { useState } from "react";

export interface SpotifyTrackItem {
  id: string;
  name: string;
  artists: string;
  album?: string;
  image?: string;
  duration?: string;
  explicit?: boolean;
  spotifyUrl?: string;
}

export interface SpotifyTracksCardData {
  query?: string;
  tracks: SpotifyTrackItem[];
  onPlayItem?: (id: string, type: "track", title?: string) => void;
}

export const SpotifyTracksCard: React.FC<SpotifyTracksCardData> = ({
  tracks,
  onPlayItem,
}) => {
  const [playingId, setPlayingId] = useState<string | null>(null);

  if (!tracks || tracks.length === 0) return null;

  const topTrack = tracks[0];
  const otherTracks = tracks.slice(1, 5);

  const handlePlayTrack = (e: React.MouseEvent, track: SpotifyTrackItem) => {
    e.stopPropagation();
    if (!track.id) return;
    setPlayingId(track.id);
    onPlayItem?.(track.id, "track", `${track.name} ${track.artists}`);
  };

  return (
    <div className="spotify-result-card">
      {/* Top Bar */}
      <div className="card-top-bar">
        <div className="spotify-pill-tag">
          <svg className="spotify-pill-icon" viewBox="0 0 24 24">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.495 17.306c-.216.353-.675.466-1.028.25-2.817-1.721-6.362-2.111-10.539-1.157-.404.093-.808-.16-.901-.564-.093-.404.16-.808.564-.901 4.576-1.045 8.5-1.002 11.654 1.344.353.216.466.675.25 1.028zm1.467-3.26c-.272.443-.852.583-1.295.311-3.224-1.982-8.139-2.555-11.952-1.398-.499.151-1.028-.135-1.179-.634-.151-.499.135-1.028.634-1.179 4.359-1.323 9.776-.682 13.481 1.595.443.272.583.852.311 1.295zm.126-3.41c-3.866-2.296-10.245-2.508-13.935-1.387-.594.18-1.226-.156-1.406-.75-.18-.594.156-1.226.75-1.406 4.238-1.286 11.278-1.036 15.733 1.609.534.317.708 1.011.391 1.545-.317.534-1.011.708-1.545.391z" />
          </svg>
          <span>Spotify Songs</span>
        </div>
      </div>

      {/* Top Result (Best Match with Prominent Green Play Button) */}
      <div
        className={`top-match-hero ${playingId === topTrack.id ? "is-playing" : ""}`}
        onClick={(e) => handlePlayTrack(e, topTrack)}
        title={`Play ${topTrack.name} by ${topTrack.artists}`}
      >
        <div className="hero-left-group">
          <div className="hero-artwork-wrap">
            {topTrack.image ? (
              <img
                className="hero-artwork"
                src={topTrack.image}
                alt={topTrack.name}
              />
            ) : (
              <div className="hero-artwork-placeholder" />
            )}
          </div>
          <div className="hero-info">
            <div className="hero-title-row">
              <span className="hero-title">{topTrack.name}</span>
            </div>
            <div className="hero-subtitle">
              {topTrack.explicit && <span className="explicit-badge">E</span>}
              <span>
                Song • {topTrack.artists}
                {topTrack.duration ? ` • ${topTrack.duration}` : ""}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className={`hero-play-btn ${playingId === topTrack.id ? "is-playing" : ""}`}
          title={`Play ${topTrack.name}`}
          onClick={(e) => handlePlayTrack(e, topTrack)}
        >
          <svg viewBox="0 0 24 24">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
      </div>

      {/* Other Matching Songs */}
      {otherTracks.length > 0 && (
        <>
          <div className="matches-section-label">Other Matching Songs</div>
          <div className="tracks-list-container">
            {otherTracks.map((trk) => (
              <div
                key={trk.id}
                className={`track-row-item ${playingId === trk.id ? "is-playing" : ""}`}
                onClick={(e) => handlePlayTrack(e, trk)}
                title={`Play ${trk.name} by ${trk.artists}`}
              >
                <div className="track-row-left">
                  <div className="track-thumb-wrap">
                    {trk.image ? (
                      <img
                        className="track-thumb"
                        src={trk.image}
                        alt={trk.name}
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
                    <div className="track-name">{trk.name}</div>
                    <div className="track-artist">
                      {trk.explicit && <span className="explicit-badge">E</span>}
                      <span>{trk.artists}</span>
                    </div>
                  </div>
                </div>

                <div className="track-row-right">
                  <span className="type-pill">Song</span>
                  {trk.duration && (
                    <span className="track-duration">{trk.duration}</span>
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
