export type SceneId = "ribbon" | "gravity" | "portal";
export type SourceKind = "demo" | "camera" | "video" | "replay" | "pointer";
export type Quality = "auto" | "high" | "balanced" | "low";
export interface VisualParams {
  palette: string;
  intensity: number;
  width: number;
  trail: number;
  speed: number;
  feather: number;
  material: "silk" | "glass" | "neon";
  quality: Quality;
}
export interface TrackedHand {
  id: "left" | "right";
  x: number;
  y: number;
  z: number;
  pinch: boolean;
  strength: number;
}
export interface MaskFrame {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface InputSample {
  /** Seconds from the beginning of a take. x/y are mirrored image coordinates in [0,1]. */
  t: number;
  hands: TrackedHand[];
  mask?: MaskFrame;
  source: SourceKind;
  /** Cumulative undo operations in this take; lets saved input reproduce removed strokes. */
  undoCount?: number;
}
export interface ScenePlugin {
  readonly id: SceneId;
  update(dt: number, t: number, input: InputSample): void;
  setParams(params: VisualParams): void;
  reset(seed: number): void;
  undo?(): void;
  dispose(): void;
}
export interface StageStats {
  objects: number;
  quality: string;
  drawCalls: number;
  geometries: number;
  textures: number;
}
export interface StageEngine {
  switchScene(id: SceneId, seed: number, params: VisualParams): Promise<void>;
  step(dt: number, t: number, input: InputSample): void;
  render(): void;
  resize(width: number, height: number): void;
  reset(seed: number): void;
  undo(): void;
  setParams(params: VisualParams): void;
  getStats(): StageStats;
  dispose(): void;
}
export interface ProjectManifest {
  format: "prism-stage";
  version: 1;
  engineVersion: "1.0.0";
  id: string;
  name: string;
  scene: SceneId;
  createdAt: string;
  seed: number;
  fixedDt: number;
  duration: number;
  params: VisualParams;
  trim: { start: number; end: number };
  aspect: "landscape" | "portrait";
  source: SourceKind;
}
export interface PrismProject {
  manifest: ProjectManifest;
  samples: InputSample[];
  thumbnail?: string;
}
export interface SavedProjectSummary {
  id: string;
  name: string;
  scene: SceneId;
  createdAt: string;
  duration: number;
  thumbnail?: string;
}
export const ENGINE_VERSION = "1.0.0" as const;
export const FIXED_DT = 1 / 60;
export const MAX_DURATION = 60;
export const DEFAULT_SEED = 20260910;
