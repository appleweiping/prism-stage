import type { SceneId } from "../core/types";
export function SceneArt({ scene }: { scene: SceneId }) {
  return (
    <svg
      className={`scene-art ${scene}`}
      viewBox="0 0 240 96"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`g-${scene}`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#e5ffb1" />
          <stop offset=".45" stopColor="#8dd0cb" />
          <stop offset="1" stopColor="#a78cd9" />
        </linearGradient>
        <radialGradient id="orb">
          <stop stopColor="#f1f6dd" />
          <stop offset=".3" stopColor="#b3d4bb" />
          <stop offset=".75" stopColor="#6c8c82" />
          <stop offset="1" stopColor="#293830" />
        </radialGradient>
      </defs>
      {scene === "ribbon" ? (
        <g fill="none" stroke={`url(#g-${scene})`} strokeLinecap="round">
          <path
            d="M29 69C15 10 189 13 203 57S44 85 62 49 153 29 173 51"
            strokeWidth="10"
            opacity=".85"
          />
          <path
            d="M46 81C12 32 151 9 192 39S90 96 56 65 129 25 175 61"
            strokeWidth="3"
          />
        </g>
      ) : scene === "gravity" ? (
        <g>
          {[
            [54, 49, 18],
            [92, 68, 11],
            [125, 34, 21],
            [161, 63, 14],
            [194, 35, 9],
          ].map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} fill="url(#orb)" />
          ))}
          <ellipse
            cx="120"
            cy="77"
            rx="82"
            ry="10"
            stroke="#6c8879"
            fill="none"
            opacity=".2"
          />
        </g>
      ) : (
        <g>
          <path
            d="M93 88Q93 56 98 45L77 63 66 41 72 37 84 52 104 31Q95 15 109 10 127 5 126 24L126 32 145 48 164 29 170 33 148 63 133 48 142 89Z"
            fill={`url(#g-${scene})`}
            opacity=".8"
          />
          <path
            d="M52 70Q120 0 185 51M56 82Q120 15 193 62M69 93Q150 42 200 81"
            fill="none"
            stroke="#999ac7"
            opacity=".25"
          />
        </g>
      )}
    </svg>
  );
}
