import type { SceneId, VisualParams } from "./types";
export const PALETTES: Record<string, string[]> = {
  aurora: ["#e7ff9d", "#89d3c8", "#879bff", "#e8b3ed"],
  ember: ["#fff1cc", "#eeb578", "#d57465", "#754d73"],
  glacier: ["#e9f9ff", "#a8e8ef", "#6a94da", "#baa5ed"],
  orchid: ["#ffe9f9", "#dfa4d4", "#a87cd9", "#6b8fd6"],
};
export const DEFAULT_PARAMS: VisualParams = {
  palette: "aurora",
  intensity: 0.85,
  width: 0.6,
  trail: 0.72,
  speed: 0.65,
  feather: 0.5,
  material: "silk",
  quality: "auto",
};
export interface Preset {
  id: string;
  name: string;
  zh: string;
  palette: string;
  params: Partial<VisualParams>;
}
export const PRESETS: Record<SceneId, Preset[]> = {
  ribbon: [
    {
      id: "aurora-silk",
      name: "Aurora silk",
      zh: "极光绸缎",
      palette: "aurora",
      params: { material: "silk", width: 0.6, trail: 0.72, intensity: 0.85 },
    },
    {
      id: "molten-gold",
      name: "Molten gold",
      zh: "熔金流光",
      palette: "ember",
      params: { material: "glass", width: 0.8, trail: 0.85, intensity: 0.65 },
    },
    {
      id: "after-hours",
      name: "After hours",
      zh: "午夜光谱",
      palette: "orchid",
      params: { material: "neon", width: 0.35, trail: 0.9, intensity: 1.1 },
    },
  ],
  gravity: [
    {
      id: "celestial",
      name: "Celestial",
      zh: "天体花园",
      palette: "aurora",
      params: { material: "glass", width: 0.6, intensity: 0.8, trail: 0.7 },
    },
    {
      id: "amber-orbit",
      name: "Amber orbit",
      zh: "琥珀轨道",
      palette: "ember",
      params: { material: "silk", width: 0.5, intensity: 0.7, trail: 0.85 },
    },
    {
      id: "ice-drift",
      name: "Ice drift",
      zh: "冰川漂流",
      palette: "glacier",
      params: { material: "neon", width: 0.55, intensity: 0.9, trail: 0.5 },
    },
  ],
  portal: [
    {
      id: "inner-cosmos",
      name: "Inner cosmos",
      zh: "身体宇宙",
      palette: "aurora",
      params: { feather: 0.5, speed: 0.65, intensity: 0.85 },
    },
    {
      id: "solar-tide",
      name: "Solar tide",
      zh: "日光潮汐",
      palette: "ember",
      params: { feather: 0.65, speed: 0.45, intensity: 0.9 },
    },
    {
      id: "liquid-dream",
      name: "Liquid dream",
      zh: "流动梦境",
      palette: "orchid",
      params: { feather: 0.35, speed: 0.8, intensity: 1.0 },
    },
  ],
};
export const SCENES = [
  {
    id: "ribbon" as const,
    number: "01",
    name: "Ribbon Atelier",
    zh: "光带工坊",
    subtitle: "Draw with movement",
    subzh: "让动作成为笔触",
    description: "A gesture. A ribbon. Something entirely yours.",
    desczh: "一个手势，一道光带，一件独属于你的作品。",
  },
  {
    id: "gravity" as const,
    number: "02",
    name: "Gravity Garden",
    zh: "引力花园",
    subtitle: "Play with physical light",
    subzh: "与有重量的光玩耍",
    description: "Catch a little light. Give it a world to move in.",
    desczh: "抓住一点光，让它在你的世界里运动。",
  },
  {
    id: "portal" as const,
    number: "03",
    name: "Silhouette Portal",
    zh: "轮廓之门",
    subtitle: "Become another world",
    subzh: "身体成为另一个世界",
    description: "An entire universe, shaped by you.",
    desczh: "由你的轮廓，塑造一整个宇宙。",
  },
];
