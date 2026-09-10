import * as THREE from "three";
import type {
  InputSample,
  SceneId,
  ScenePlugin,
  StageEngine,
  StageStats,
  VisualParams,
} from "../core/types";
import { Atmosphere, WORLD_HEIGHT, WORLD_WIDTH } from "./common";
import { RibbonScene } from "./RibbonScene";
import { PortalScene } from "./PortalScene";

/** A single renderer survives scene switches; everything scene-owned is disposed. */
export async function createStage(
  canvas: HTMLCanvasElement,
): Promise<StageEngine> {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
  } catch (error) {
    throw new Error(
      `WebGL2 could not start. Enable hardware acceleration or try an up-to-date Chrome or Edge. ${error instanceof Error ? error.message : ""}`,
    );
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor("#101216", 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const camera = new THREE.OrthographicCamera(
    -WORLD_WIDTH / 2,
    WORLD_WIDTH / 2,
    WORLD_HEIGHT / 2,
    -WORLD_HEIGHT / 2,
    0.1,
    50,
  );
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);
  let current:
    | { scene: THREE.Scene; plugin: ScenePlugin; atmosphere: Atmosphere }
    | undefined;
  let version = 0;
  let disposed = false;
  let width = canvas.clientWidth || 1280;
  let height = canvas.clientHeight || 720;
  let quality: VisualParams["quality"] = "auto";
  let scale = 1;
  let lastRenderAt = 0;
  let frameCount = 0;
  let frameDuration = 0;
  let autoScale = 1;

  function resize(): void {
    const aspect = Math.max(1, width) / Math.max(1, height);
    // A taller viewport changes only the crop. Input and simulation remain 12 × 6.75.
    camera.top = WORLD_HEIGHT / 2;
    camera.bottom = -WORLD_HEIGHT / 2;
    camera.left = (-WORLD_HEIGHT * aspect) / 2;
    camera.right = (WORLD_HEIGHT * aspect) / 2;
    camera.updateProjectionMatrix();
    scale =
      quality === "low"
        ? 0.65
        : quality === "balanced"
          ? 0.82
          : quality === "high"
            ? 1
            : autoScale;
    renderer.setSize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
      false,
    );
  }

  const engine: StageEngine = {
    async switchScene(
      id: SceneId,
      seed: number,
      params: VisualParams,
    ): Promise<void> {
      if (disposed) throw new Error("The stage has been disposed.");
      const requestVersion = ++version;
      const scene = new THREE.Scene();
      let plugin: ScenePlugin;
      try {
        if (id === "gravity") {
          const { GravityScene } = await import("./GravityScene");
          plugin = await GravityScene.create(scene, seed, params);
        } else if (id === "portal")
          plugin = new PortalScene(scene, seed, params);
        else plugin = new RibbonScene(scene, seed, params);
      } catch (error) {
        throw new Error(
          `The ${id} stage could not start. Retry the stage or reload its offline assets. ${error instanceof Error ? error.message : ""}`,
        );
      }
      if (requestVersion !== version || disposed) {
        plugin.dispose();
        return;
      }
      current?.plugin.dispose();
      current?.atmosphere.dispose();
      renderer.renderLists.dispose();
      current = {
        scene,
        plugin,
        atmosphere: new Atmosphere(scene, seed, params),
      };
      quality = params.quality;
      resize();
      renderer.render(scene, camera);
    },
    step(dt: number, t: number, input: InputSample): void {
      if (disposed || !current) return;
      current.plugin.update(dt, t, input);
      current.atmosphere.update(t);
    },
    render(): void {
      if (disposed || !current) return;
      const now = performance.now();
      if (lastRenderAt && quality === "auto") {
        const elapsed = now - lastRenderAt;
        // Ignore background gaps and timeline reconstruction work. Only visual
        // resolution adapts; simulation timesteps and export aspect never change.
        if (elapsed < 100 && elapsed > 4) {
          frameDuration += elapsed;
          frameCount++;
        }
        if (frameCount >= 120) {
          const average = frameDuration / frameCount;
          if (average > 36 && autoScale > 0.66) {
            autoScale = autoScale > 0.85 ? 0.82 : 0.65;
            resize();
          }
          frameCount = 0;
          frameDuration = 0;
        }
      }
      lastRenderAt = now;
      renderer.render(current.scene, camera);
    },
    resize(newWidth: number, newHeight: number): void {
      width = Math.max(1, newWidth);
      height = Math.max(1, newHeight);
      resize();
    },
    reset(seed: number): void {
      current?.plugin.reset(seed);
    },
    undo(): void {
      current?.plugin.undo?.();
    },
    setParams(params: VisualParams): void {
      current?.plugin.setParams(params);
      current?.atmosphere.setParams(params);
      if (quality !== params.quality) {
        quality = params.quality;
        resize();
      }
    },
    getStats(): StageStats {
      return {
        objects:
          current?.scene.children.reduce((sum, child) => {
            child.traverse(() => sum++);
            return sum;
          }, 0) ?? 0,
        quality: `${scale >= 0.99 ? "High" : scale >= 0.8 ? "Balanced" : "Low"}${quality === "auto" ? " · auto" : ""}`,
        drawCalls: renderer.info.render.calls,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      version++;
      current?.plugin.dispose();
      current?.atmosphere.dispose();
      current = undefined;
      // Do not force context loss: React StrictMode can create the next renderer
      // on this same canvas before a cancelled async initialization disposes.
      // Renderer.dispose frees owned GPU resources without invalidating that renderer.
      renderer.renderLists.dispose();
      renderer.dispose();
    },
  };
  resize();
  return engine;
}
