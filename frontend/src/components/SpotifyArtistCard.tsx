import React from "react";

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
  onPlayItem,
}) => {
  const handlePlayArtist = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPlayItem?.(artistId, "artist", `${name} Radio`);
  };

  const listenersText = monthlyListeners || followers || "Popular on Spotify";
  const displayGenres = genres && genres !== "Music" ? genres : "";

  // Artist photo backdrop — dual-axis vignette renders on .artist-hero-vignette overlay
  // so the gradients span edge-to-edge without backgroundSize/Position or subpixel DPI bleed
  const cardStyle: React.CSSProperties = image
    ? {
        backgroundImage: `url("${image}")`,
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
      {image && <div className="artist-hero-vignette" aria-hidden="true" />}

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
