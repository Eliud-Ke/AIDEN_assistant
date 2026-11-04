import React, { useEffect, useRef } from "react";

export interface WeatherCardData {
  location: string;
  temp: number;
  tempHigh?: number;
  tempLow?: number;
  unit?: string;
  condition: string;
  conditionKey: string;
  weatherCode?: number;
  isDay?: boolean;
}

const WEATHER_ICONS: Record<string, React.ReactNode> = {
  // Day
  sunny: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="5" />
      <path
        d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  cloudy: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
    </svg>
  ),
  overcast: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
    </svg>
  ),
  rain: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
      <line x1="8" y1="21" x2="6" y2="25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="13" y1="21" x2="11" y2="25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="18" y1="21" x2="16" y2="25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  thunderstorm: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
      <polygon points="13,17 9,23 12,23 11,27 16,21 13,21" fill="currentColor" />
    </svg>
  ),
  snow: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
      <circle cx="8" cy="23" r="1.5" fill="currentColor" />
      <circle cx="13" cy="23" r="1.5" fill="currentColor" />
      <circle cx="18" cy="23" r="1.5" fill="currentColor" />
    </svg>
  ),
  sandstorm: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 8h14a3 3 0 1 0-3-3M2 13h17a3 3 0 1 0-3-3M5 18h11a3 3 0 1 0-3-3" />
    </svg>
  ),
  fog: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
      <line x1="3" y1="21" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="5" y1="24" x2="19" y2="24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  windy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" />
    </svg>
  ),

  // Night
  "clear-night": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.3 2a10 10 0 0 0 9.7 12.7 10 10 0 1 1-12.7-9.7c.3 0 .7.1 1 .2-.6-1.1-1-2.2-1-3.2 0 0 1.5 0 3 0z" />
      <circle cx="18" cy="4" r="1" fill="currentColor" />
      <circle cx="21" cy="8" r="0.75" fill="currentColor" />
    </svg>
  ),
  "cloudy-night": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 12a5 5 0 0 0-4.9-4 5.1 5.1 0 0 0-1.5.2A6 6 0 1 0 3 13.5 5 5 0 0 0 7 18h10a4 4 0 0 0 0-8z" />
      <path
        d="M12.3 2a7 7 0 0 0 5.8 8.2A5 5 0 0 1 17 12a5 5 0 0 0-4.9-4 5.1 5.1 0 0 0-1.5.2A7 7 0 0 1 12.3 2z"
        opacity="0.85"
      />
    </svg>
  ),
  "overcast-night": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
    </svg>
  ),
  "rain-night": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 12a5 5 0 0 0-4.9-4 5.1 5.1 0 0 0-1.5.2A6 6 0 1 0 3 13.5 5 5 0 0 0 7 18h10a4 4 0 0 0 0-8z" />
      <line x1="7" y1="21" x2="5" y2="25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="21" x2="10" y2="25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="17" y1="21" x2="15" y2="25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  "thunderstorm-night": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 12a5 5 0 0 0-4.9-4 5.1 5.1 0 0 0-1.5.2A6 6 0 1 0 3 13.5 5 5 0 0 0 7 18h10a4 4 0 0 0 0-8z" />
      <polygon points="13,17 9,23 12,23 11,27 16,21 13,21" fill="currentColor" />
    </svg>
  ),
  "snow-night": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 12a5 5 0 0 0-4.9-4 5.1 5.1 0 0 0-1.5.2A6 6 0 1 0 3 13.5 5 5 0 0 0 7 18h10a4 4 0 0 0 0-8z" />
      <circle cx="7" cy="22" r="1.5" fill="currentColor" />
      <circle cx="12" cy="22" r="1.5" fill="currentColor" />
      <circle cx="17" cy="22" r="1.5" fill="currentColor" />
    </svg>
  ),
  "sandstorm-night": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 8h14a3 3 0 1 0-3-3M2 13h17a3 3 0 1 0-3-3M5 18h11a3 3 0 1 0-3-3" />
    </svg>
  ),
  "fog-night": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 12a5 5 0 0 0-4.9-4 5.1 5.1 0 0 0-1.5.2A6 6 0 1 0 3 13.5 5 5 0 0 0 7 18h10a4 4 0 0 0 0-8z" />
      <line x1="3" y1="21" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="5" y1="24" x2="19" y2="24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  "windy-night": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" />
    </svg>
  ),
};

export const WeatherCard: React.FC<WeatherCardData> = ({
  location,
  temp,
  tempHigh,
  tempLow,
  condition,
  conditionKey,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const flashRef = useRef<HTMLDivElement | null>(null);

  // Normalize condition key
  const normalizedKey = (conditionKey || "cloudy").toLowerCase().trim();

  // Particle Canvas & Lightning Flash Engine
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const cond = normalizedKey;
    let mode: "rain" | "snow" | "sandstorm" | "stars" | "none" = "none";

    const w = (canvas.width = canvas.parentElement?.offsetWidth || 380);
    const h = (canvas.height = canvas.parentElement?.offsetHeight || 130);

    const particles: any[] = [];

    if (cond.includes("rain") || cond.includes("thunderstorm")) {
      mode = "rain";
      const count = cond.includes("thunderstorm") ? 55 : 36;
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          speed: 5 + Math.random() * 6,
          len: 10 + Math.random() * 12,
          opacity: 0.25 + Math.random() * 0.4,
        });
      }
    } else if (cond.includes("snow")) {
      mode = "snow";
      for (let i = 0; i < 40; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          speed: 0.8 + Math.random() * 1.6,
          radius: 1 + Math.random() * 2.2,
          sway: Math.random() * 10,
          opacity: 0.3 + Math.random() * 0.55,
        });
      }
    } else if (cond.includes("sandstorm")) {
      mode = "sandstorm";
      for (let i = 0; i < 65; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          speedX: 7 + Math.random() * 9,
          speedY: (Math.random() - 0.5) * 1.5,
          len: 4 + Math.random() * 14,
          opacity: 0.25 + Math.random() * 0.45,
        });
      }
    } else if (cond.includes("clear-night") || cond.includes("cloudy-night")) {
      mode = "stars";
      for (let i = 0; i < 28; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          radius: 0.6 + Math.random() * 1.2,
          baseOpacity: 0.2 + Math.random() * 0.5,
          phase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.02 + Math.random() * 0.03,
        });
      }
    }

    const render = () => {
      ctx.clearRect(0, 0, w, h);

      if (mode === "rain") {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
        ctx.lineWidth = 1.2;
        for (let p of particles) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - 1.2, p.y + p.len);
          ctx.stroke();

          p.y += p.speed;
          p.x -= 0.8;
          if (p.y > h) {
            p.y = -12;
            p.x = Math.random() * (w + 30);
          }
        }
      } else if (mode === "snow") {
        ctx.fillStyle = "#ffffff";
        for (let p of particles) {
          ctx.globalAlpha = p.opacity;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fill();

          p.y += p.speed;
          p.sway += 0.02;
          p.x += Math.sin(p.sway) * 0.6;
          if (p.y > h) {
            p.y = -5;
            p.x = Math.random() * w;
          }
        }
        ctx.globalAlpha = 1;
      } else if (mode === "sandstorm") {
        ctx.strokeStyle = "#f6d365";
        ctx.lineWidth = 1;
        for (let p of particles) {
          ctx.globalAlpha = p.opacity;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + p.len, p.y + p.speedY);
          ctx.stroke();

          p.x += p.speedX;
          p.y += p.speedY;
          if (p.x > w) {
            p.x = -20;
            p.y = Math.random() * h;
          }
        }
        ctx.globalAlpha = 1;
      } else if (mode === "stars") {
        ctx.fillStyle = "#ffffff";
        for (let p of particles) {
          p.phase += p.twinkleSpeed;
          const alpha = p.baseOpacity + Math.sin(p.phase) * 0.25;
          ctx.globalAlpha = Math.max(0.1, Math.min(1, alpha));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      animId = requestAnimationFrame(render);
    };

    if (mode !== "none") {
      animId = requestAnimationFrame(render);
    }

    // Thunderstorm Lightning Flash Simulator
    let lightningTimer: any = null;
    if (cond.includes("thunderstorm")) {
      const flash = flashRef.current;
      lightningTimer = setInterval(() => {
        if (!flash || Math.random() > 0.65) return;
        flash.style.background = "rgba(255, 255, 255, 0.55)";
        setTimeout(() => {
          flash.style.background = "rgba(255, 255, 255, 0)";
          setTimeout(() => {
            flash.style.background = "rgba(215, 195, 255, 0.4)";
            setTimeout(() => {
              flash.style.background = "rgba(255, 255, 255, 0)";
            }, 60);
          }, 50);
        }, 70);
      }, 4200);
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
      if (lightningTimer) clearInterval(lightningTimer);
    };
  }, [normalizedKey]);

  // Icon fallback
  const icon = WEATHER_ICONS[normalizedKey] || WEATHER_ICONS.cloudy;

  const roundedTemp = Math.round(temp);
  const hasHighLow = typeof tempHigh === "number" && typeof tempLow === "number";

  return (
    <div className={`apple-weather-card theme-${normalizedKey}`}>
      {/* Atmospheric Smokey Clouds Layer */}
      <div className="clouds-backdrop">
        <div className="cloud-puff cloud-1" />
        <div className="cloud-puff cloud-2" />
        <div className="cloud-puff cloud-3" />
      </div>

      {/* Lightning Flash Overlay */}
      <div className="lightning-flash" ref={flashRef} />

      {/* Dynamic Weather Particle FX */}
      <canvas className="weather-canvas" ref={canvasRef} />

      {/* Left: Location & Large Current Temperature */}
      <div className="card-left">
        <div className="card-location">{location}</div>
        <div className="card-temp">{roundedTemp}°</div>
      </div>

      {/* Right: Weather Icon & Condition Meta */}
      <div className="card-right">
        <div className="card-icon-wrapper">
          <div className="card-icon">{icon}</div>
        </div>

        <div className="card-meta-bottom">
          <div className="card-condition">{condition}</div>
          {hasHighLow && (
            <div className="card-highlow">
              H:{Math.round(tempHigh!)}° L:{Math.round(tempLow!)}°
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
