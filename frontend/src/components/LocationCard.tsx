import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface LocationCardProps {
  lat: number;
  lon: number;
  title?: string;
}

export const LocationCard: React.FC<LocationCardProps> = ({ lat, lon, title }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Initialize Leaflet Map
    const map = L.map(mapContainerRef.current, {
      center: [lat, lon],
      zoom: 15,
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: true,
    });

    // Standard OpenStreetMap Daylight Tiles (100% Free, Zero API Keys, Zero Watermarks)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      subdomains: ["a", "b", "c"],
      maxZoom: 19,
    }).addTo(map);

    // Clean Google Maps Red Teardrop Pin (No glow, no pulsing)
    const googlePinHtml = `
      <div class="google-pin-wrapper">
        <svg class="google-pin-svg" viewBox="0 0 30 42" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="15" cy="40.5" rx="5.5" ry="1.5" fill="rgba(0, 0, 0, 0.45)"/>
          <path d="M15 0C6.71573 0 0 6.71573 0 15C0 24.8 13.5 38.8 14.35 39.7C14.7 40.1 15.3 40.1 15.65 39.7C16.5 38.8 30 24.8 30 15C30 6.71573 23.2843 0 15 0Z" fill="#EA4335"/>
          <path d="M15 0C6.71573 0 0 6.71573 0 15C0 19.5 2 23.5 5.5 27C8 24.5 11.5 23 15 23C18.5 23 22 24.5 24.5 27C28 23.5 30 19.5 30 15C30 6.71573 23.2843 0 15 0Z" fill="#D93025" opacity="0.3"/>
          <circle cx="15" cy="14" r="5" fill="#FFFFFF"/>
        </svg>
      </div>
    `;

    const googlePinIcon = L.divIcon({
      className: "",
      html: googlePinHtml,
      iconSize: [30, 42],
      iconAnchor: [15, 41],
    });

    L.marker([lat, lon], { icon: googlePinIcon }).addTo(map);
    mapInstanceRef.current = map;

    // Invalidate map size after container mounts or morphs
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 120);

    return () => {
      clearTimeout(timer);
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [lat, lon]);

  const handleRecenter = (e: React.MouseEvent) => {
    e.stopPropagation();
    mapInstanceRef.current?.flyTo([lat, lon], 15, { duration: 1.2 });
  };

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    mapInstanceRef.current?.zoomIn();
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    mapInstanceRef.current?.zoomOut();
  };

  const handleOpenMaps = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const url = `https://www.google.com/maps?q=${lat},${lon}`;
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const locationLabel = title || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  return (
    <div className="siri-location-card">
      <div ref={mapContainerRef} className="siri-location-map" />

      {/* Top Bar: Always visible, no hover hide/show */}
      <div className="siri-location-top-bar">
        {/* Top-Left Location Pill (Pressing opens Maps) */}
        <button
          type="button"
          className="siri-location-pill"
          onClick={handleOpenMaps}
          title="Open in Google Maps"
        >
          <svg
            className="siri-location-pin-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z" />
          </svg>
          <span className="siri-location-pill-text">{locationLabel}</span>
          <svg
            className="siri-location-pill-arrow"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>

        {/* Top-Right Tools Group (Recenter, +, −) */}
        <div className="siri-location-tools-group">
          <button
            type="button"
            className="siri-location-tool-btn"
            onClick={handleRecenter}
            title="Recenter to Pin"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="7" />
              <polyline points="12 2 12 5" />
              <polyline points="12 19 12 22" />
              <polyline points="2 12 5 12" />
              <polyline points="19 12 22 12" />
            </svg>
          </button>
          <button
            type="button"
            className="siri-location-tool-btn"
            onClick={handleZoomIn}
            title="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            className="siri-location-tool-btn"
            onClick={handleZoomOut}
            title="Zoom Out"
          >
            −
          </button>
        </div>
      </div>
    </div>
  );
};
