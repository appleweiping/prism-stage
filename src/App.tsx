import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Camera,
  Check,
  ChevronDown,
  Circle,
  CircleHelp,
  Download,
  Expand,
  FileUp,
  Film,
  FolderOpen,
  Github,
  Hand,
  Languages,
  LoaderCircle,
  Monitor,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  Video,
  WifiOff,
  X,
} from "lucide-react";
import { StudioRuntime, type RuntimeState } from "./core/StudioRuntime";
import { DEFAULT_PARAMS, PALETTES, PRESETS, SCENES } from "./core/presets";
import type { PrismProject, SavedProjectSummary, SceneId } from "./core/types";
import { SceneArt } from "./components/SceneArt";
import { canvasPng, downloadBlob } from "./export/recorder";
import {
  decodeProject,
  deleteProject,
  encodeProject,
  listProjects,
  loadProject,
  saveProject,
} from "./storage/projects";
import { initOffline, prepareOffline, type OfflineState } from "./offline";

const initial: RuntimeState = {
  ready: false,
  scene: "ribbon",
  source: "demo",
  mode: "live",
  playing: true,
  time: 0,
  duration: 0,
  fps: 0,
  inferenceMs: 0,
  visionFps: 0,
  status: { state: "idle", message: "Demo motion" },
  params: DEFAULT_PARAMS,
  samples: 0,
  error: "",
  aspect: "landscape",
  trimStart: 0,
  trimEnd: 0,
  delegate: "",
  quality: "auto",
};
const formatTime = (t: number) =>
  `${Math.floor(t / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(t % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((t % 1) * 10)}`;
type Language = "en" | "zh";
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    videoRef = useRef<HTMLVideoElement>(null),
    stageRef = useRef<HTMLDivElement>(null);
  const projectInput = useRef<HTMLInputElement>(null),
    videoInput = useRef<HTMLInputElement>(null),
    runtimeRef = useRef<StudioRuntime | null>(null);
  const [state, setState] = useState(initial),
    [lang, setLang] = useState<Language>(() => {
      try {
        return localStorage.getItem("prism-language") === "zh" ? "zh" : "en";
      } catch {
        return "en";
      }
    });
  const [modal, setModal] = useState<
      "export" | "library" | "help" | "save" | null
    >(null),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<SavedProjectSummary[]>([]),
    [projectName, setProjectName] = useState("Aurora study"),
    [reduced, setReduced] = useState(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  const [offline, setOffline] = useState<OfflineState>({
    state: "idle",
    progress: 0,
    message: "",
  });
  const [exportResult, setExportResult] = useState<{
    blob: Blob;
    url: string;
    extension: string;
  } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const t = useCallback(
    (en: string, zh: string) => (lang === "zh" ? zh : en),
    [lang],
  );
  const report = useCallback((message: string) => {
    setNotice(message);
  }, []);
  const run = useCallback(
    async (label: string, fn: () => void | Promise<void>) => {
      setBusy(label);
      try {
        await fn();
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy("");
      }
    },
    [report],
  );
  useEffect(() => {
    if (!canvasRef.current || !videoRef.current) return;
    const runtime = new StudioRuntime(
      canvasRef.current,
      videoRef.current,
      setState,
    );
    runtimeRef.current = runtime;
    void runtime
      .init()
      .then(() =>
        runtime.setReducedMotion(
          matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      );
    const visibility = () => {
      if (document.hidden && stateRef.current.mode === "recording")
        runtime.stopTake();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      runtime.dispose();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let alive = true;
    void initOffline((s) => {
      if (alive) setOffline(s);
    }).then((c) => {
      if (alive) cleanup = c;
      else c();
    });
    return () => {
      alive = false;
      cleanup?.();
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("prism-language", lang);
    } catch {
      // Language remains usable when browser preferences cannot be persisted.
    }
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    return () => {
      if (exportResult) URL.revokeObjectURL(exportResult.url);
    };
  }, [exportResult]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).matches("input,textarea,select") ||
        modal
      )
        return;
      if (event.code === "Space") {
        event.preventDefault();
        runtimeRef.current?.togglePlay();
      }
      if (event.key.toLowerCase() === "r" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        void run("", async () => {
          if (stateRef.current.mode === "recording")
            runtimeRef.current?.stopTake();
          else await runtimeRef.current?.startTake();
        });
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "z") {
        event.preventDefault();
        runtimeRef.current?.undo();
      }
      if (event.key === "Escape") {
        runtimeRef.current?.abortExport();
        setModal(null);
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [modal, run]);
  useEffect(() => {
    if (modal === "library")
      void listProjects()
        .then(setProjects)
        .catch((e) => report(String(e)));
  }, [modal, report]);
  const scene = SCENES.find((s) => s.id === state.scene)!;
  const isTake = state.duration > 0.1,
    locked =
      !state.ready || state.mode === "recording" || state.mode === "exporting";
  const sourceLabel =
    state.mode === "replay" || state.mode === "exporting"
      ? t("Recorded motion", "已录制动作")
      : state.source === "demo"
        ? t("Demo motion · synthetic", "演示动作 · 模拟输入")
        : state.source === "camera"
          ? t("Live camera", "实时摄像头")
          : t("Local video", "本地视频");
  async function openProject(project: PrismProject) {
    await runtimeRef.current?.load(project);
    setProjectName(project.manifest.name);
    setModal(null);
    report(
      t(
        "Project opened. Your movement, ready to reimagine.",
        "工程已打开。为这段动作赋予新的色彩。",
      ),
    );
  }
  async function saveCurrent() {
    const project = runtimeRef.current!.snapshot(projectName);
    await saveProject(project);
    report(t("Saved to your local collection.", "已保存到本地作品库。"));
    setModal(null);
  }
  async function exportProject() {
    const project = runtimeRef.current!.snapshot(projectName);
    const blob = await encodeProject(project);
    downloadBlob(
      blob,
      `${projectName.replace(/[^\p{L}\p{N}\-_ ]/gu, "") || "prism-study"}.prismstage`,
    );
    report(t("Editable project downloaded.", "可编辑工程已下载。"));
  }
  async function exportVideo() {
    setExportResult(null);
    const result = await runtimeRef.current!.exportVideo();
    const url = URL.createObjectURL(result.blob);
    setExportResult({ ...result, url });
    report(
      t(
        "Your film is ready. Preview it, then download.",
        "成片已就绪，可预览并下载。",
      ),
    );
  }
  return (
    <div className={`app ${reduced ? "reduced-motion" : ""}`}>
      <header className="app-header">
        <a
          className="brand"
          href={import.meta.env.BASE_URL}
          aria-label="Prism Stage home"
        >
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span>
            prism<span className="brand-light">stage</span>
            <small>MOTION TO ART</small>
          </span>
        </a>
        <div className="header-middle">
          <span className="status-dot" />
          {t("Your movement. A new medium.", "让动作，成为新的创作媒介。")}
        </div>
        <nav
          className="header-actions"
          aria-label={t("Main navigation", "主导航")}
        >
          <button
            className="text-button"
            disabled={locked}
            onClick={() => setModal("library")}
          >
            <FolderOpen size={16} />
            <span>{t("My collection", "我的作品")}</span>
          </button>
          <button
            className="icon-button"
            title={t("Switch to Chinese", "切换为英文")}
            aria-label="Switch language"
            onClick={() => setLang(lang === "en" ? "zh" : "en")}
          >
            <Languages size={17} />
          </button>
          <a
            className="icon-button"
            title="GitHub"
            aria-label="GitHub repository"
            href="https://github.com/appleweiping/prism-stage"
            target="_blank"
            rel="noreferrer"
          >
            <Github size={17} />
          </a>
        </nav>
      </header>
      <div className="studio-heading">
        <div>
          <p className="eyebrow">
            THE INTERACTIVE STUDIO <span>—</span> VOL. 01
          </p>
          <h1>{t("Make something only you can.", "创作，独属于你的光。")}</h1>
        </div>
        <div className="heading-side">
          <ShieldCheck size={15} />
          <span>
            {t("On your device. Entirely yours.", "本地运行，作品属于你。")}
          </span>
        </div>
      </div>
      <main className="workspace">
        <aside
          className="scene-sidebar"
          aria-label={t("Choose a stage", "选择舞台")}
        >
          <div className="section-label">
            {t("THE STAGES", "创作舞台")}
            <span>03</span>
          </div>
          <div className="scene-list">
            {SCENES.map((s) => (
              <button
                key={s.id}
                className={`scene-card ${state.scene === s.id ? "selected" : ""}`}
                disabled={locked}
                onClick={() =>
                  void run("", () => runtimeRef.current!.setScene(s.id))
                }
                aria-pressed={state.scene === s.id}
                data-testid={`scene-${s.id}`}
              >
                <div className="scene-art-wrap">
                  <SceneArt scene={s.id} />
                  <span className="scene-number">{s.number}</span>
                  {state.scene === s.id ? (
                    <span className="selected-dot" />
                  ) : null}
                </div>
                <div className="scene-card-text">
                  <strong>{lang === "zh" ? s.zh : s.name}</strong>
                  <span>{lang === "zh" ? s.subzh : s.subtitle}</span>
                </div>
              </button>
            ))}
          </div>
          <div className="sidebar-note">
            <Hand size={20} strokeWidth={1.3} />
            <p>
              {t("No canvas. No limits.", "没有画笔，也能创作。")}
              <span>
                {t("Just you, and a little motion.", "从一个小小的动作开始。")}
              </span>
            </p>
          </div>
          <button className="help-link" onClick={() => setModal("help")}>
            <CircleHelp size={15} />
            {t("A quick guide", "一分钟上手")}
            <ArrowUpRight size={14} />
          </button>
        </aside>
        <section
          className="center-column"
          aria-label={t("Creative stage", "创作画面")}
        >
          <div className="stage-toolbar">
            <div className="stage-title">
              <span>{scene.number}</span>
              <h2>{lang === "zh" ? scene.zh : scene.name}</h2>
            </div>
            <div className="stage-tools">
              <button
                className="icon-button"
                disabled={
                  locked || state.mode === "replay" || state.scene !== "ribbon"
                }
                title={t("Undo last stroke (Ctrl+Z)", "撤销上一笔 (Ctrl+Z)")}
                aria-label="Undo last stroke"
                onClick={() => runtimeRef.current?.undo()}
              >
                <Undo2 size={16} />
              </button>
              <button
                className="icon-button"
                disabled={locked}
                title={t("Clear stage", "清空舞台")}
                aria-label="Clear stage"
                onClick={() => runtimeRef.current?.clear()}
              >
                <RotateCcw size={15} />
              </button>
              <span className="tool-divider" />
              <button
                className="aspect-button"
                disabled={locked}
                aria-label="Toggle aspect ratio"
                onClick={() =>
                  runtimeRef.current?.setAspect(
                    state.aspect === "landscape" ? "portrait" : "landscape",
                  )
                }
              >
                <Monitor size={14} />
                {state.aspect === "landscape" ? "16:9" : "9:16"}
              </button>
              <button
                className="icon-button"
                aria-label="Fullscreen"
                onClick={() =>
                  void run("", async () => {
                    if (document.fullscreenElement)
                      await document.exitFullscreen();
                    else await stageRef.current?.requestFullscreen();
                  })
                }
              >
                <Expand size={15} />
              </button>
            </div>
          </div>
          <div className={`stage-viewport ${state.aspect}`} ref={stageRef}>
            <canvas
              ref={canvasRef}
              aria-label={`${scene.name} rendered artwork`}
              data-testid="artwork-canvas"
            />
            <div className="stage-overlays">
              <span
                className={`source-badge ${state.mode === "recording" ? "recording" : ""}`}
              >
                <span />
                {state.mode === "recording"
                  ? t("Recording motion", "正在录制动作")
                  : sourceLabel}
              </span>
              <span className="live-stats" data-testid="fps">
                {state.fps} <small>FPS</small>
              </span>
            </div>
            {!state.ready ? (
              <div className="stage-loading">
                <LoaderCircle size={26} className="spin" />
                <span>{t("Preparing your stage…", "正在准备舞台…")}</span>
              </div>
            ) : null}
            <div className="stage-bottom">
              <div className="stage-caption">
                <span className="caption-line" />
                <p>{lang === "zh" ? scene.desczh : scene.description}</p>
              </div>
              <span className="stage-watermark">PRISM / {scene.number}</span>
            </div>
            <div
              className={`camera-preview ${(state.source === "camera" || state.source === "video") && state.mode !== "replay" && state.mode !== "exporting" ? "visible" : ""}`}
            >
              <video
                ref={videoRef}
                muted
                playsInline
                aria-label="Camera calibration preview"
              />
              <span>{t("LOCAL PREVIEW", "本地预览")}</span>
            </div>
            {(state.source === "camera" || state.source === "video") &&
            state.status.state === "loading" ? (
              <div className="model-loading">
                <LoaderCircle className="spin" size={16} />
                {t("Loading local vision model…", "正在加载本地视觉模型…")}
              </div>
            ) : null}
          </div>
          <div className="transport">
            <div className="transport-main">
              <button
                className={`record-button ${state.mode === "recording" ? "active" : ""}`}
                disabled={!state.ready || state.mode === "exporting"}
                onClick={() =>
                  void run("", async () => {
                    if (state.mode === "recording")
                      runtimeRef.current?.stopTake();
                    else await runtimeRef.current?.startTake();
                  })
                }
                data-testid="record-button"
              >
                {state.mode === "recording" ? (
                  <Square size={12} fill="currentColor" />
                ) : (
                  <Circle size={12} fill="currentColor" />
                )}
                {state.mode === "recording"
                  ? t("Finish take", "结束录制")
                  : t("Record motion", "录制动作")}
              </button>
              <button
                className="icon-button playback"
                disabled={!state.ready || state.mode === "exporting"}
                aria-label={state.playing ? "Pause" : "Play"}
                onClick={() => runtimeRef.current?.togglePlay()}
              >
                {state.playing ? <Pause size={17} /> : <Play size={17} />}
              </button>
              <time>
                {formatTime(state.mode === "live" ? 0 : state.time)}
                <span>
                  {" "}
                  /{" "}
                  {formatTime(state.mode === "recording" ? 60 : state.duration)}
                </span>
              </time>
              <div className="transport-spacer" />
              <button
                className="icon-button"
                disabled={!isTake || locked}
                aria-label="Replay take"
                title={t("Replay take", "回放动作")}
                onClick={() => runtimeRef.current?.replay()}
              >
                <RotateCcw size={15} />
              </button>
              <button
                className="icon-button"
                disabled={!isTake || locked}
                title={t("Save project", "保存工程")}
                aria-label="Save project"
                onClick={() => setModal("save")}
              >
                <Save size={16} />
              </button>
            </div>
            <input
              className="timeline"
              aria-label="Playback position"
              type="range"
              min="0"
              max={state.duration || 60}
              step="0.016667"
              value={state.mode === "live" ? 0 : state.time}
              disabled={!isTake || locked}
              onChange={(e) => runtimeRef.current?.seek(Number(e.target.value))}
              style={
                {
                  "--progress": `${state.duration ? (state.time / state.duration) * 100 : 0}%`,
                } as React.CSSProperties
              }
            />
            <div className="transport-foot">
              <span>
                <span className="tiny-dot" />
                {state.mode === "replay"
                  ? t(
                      "Movement captured. Reimagine the finish.",
                      "动作已保存，现在可以重新设计外观。",
                    )
                  : t(
                      "Capture the movement. Change the look later.",
                      "先记录动作，再自由改变视觉。",
                    )}
              </span>
              <kbd>R</kbd>
              <span>{t("to record", "录制")}</span>
            </div>
          </div>
          <div className="input-panel">
            <div>
              <span className="section-label">
                {t("YOUR INPUT", "输入来源")}
              </span>
              <p>
                {t(
                  "A demo to explore. Your camera to create.",
                  "用演示探索，用镜头创作。",
                )}
              </p>
            </div>
            <div className="input-actions">
              <button
                className={`input-button ${state.source === "demo" ? "active" : ""}`}
                disabled={locked}
                onClick={() =>
                  void run("", () => runtimeRef.current!.setSource("demo"))
                }
              >
                <Sparkles size={15} />
                {t("Demo", "演示")}
              </button>
              <button
                className={`input-button ${state.source === "camera" ? "active" : ""}`}
                disabled={locked}
                data-testid="camera-button"
                onClick={() =>
                  void run("camera", () =>
                    runtimeRef.current!.setSource("camera"),
                  )
                }
              >
                <Camera size={15} />
                {t("Use camera", "开启摄像头")}
              </button>
              <button
                className={`input-button ${state.source === "video" ? "active" : ""}`}
                disabled={locked}
                onClick={() => videoInput.current?.click()}
              >
                <FileUp size={15} />
                {t("Local video", "本地视频")}
              </button>
            </div>
          </div>
        </section>
        <aside
          className="inspector"
          aria-label={t("Appearance settings", "视觉设置")}
        >
          <div className="section-label">
            <span>
              <SlidersHorizontal size={13} />
              {t("MAKE IT YOURS", "塑造你的作品")}
            </span>
            <span>↗</span>
          </div>
          <div className="inspector-section">
            <label className="field-label">
              {t("Starting point", "风格预设")}
              <span>01—03</span>
            </label>
            <div className="preset-list">
              {PRESETS[state.scene].map((p) => (
                <button
                  key={p.id}
                  disabled={state.mode === "exporting"}
                  className={`preset-button ${state.params.palette === p.palette ? "active" : ""}`}
                  onClick={() =>
                    runtimeRef.current?.setParams({
                      ...p.params,
                      palette: p.palette,
                    })
                  }
                >
                  <span className={`preset-swatch ${p.palette}`} />
                  <span>{lang === "zh" ? p.zh : p.name}</span>
                  {state.params.palette === p.palette ? (
                    <Check size={13} />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <div className="inspector-section">
            <label className="field-label">
              {t("Color story", "色彩故事")}
              <span>{state.params.palette}</span>
            </label>
            <div className="palette-options">
              {Object.entries(PALETTES).map(([name, colors]) => (
                <button
                  key={name}
                  className={`palette-option ${state.params.palette === name ? "active" : ""}`}
                  disabled={state.mode === "exporting"}
                  aria-label={`Palette ${name}`}
                  title={name}
                  onClick={() =>
                    runtimeRef.current?.setParams({ palette: name })
                  }
                  style={{
                    background: `linear-gradient(135deg,${colors.join(",")})`,
                  }}
                />
              ))}
            </div>
            {state.scene !== "portal" ? (
              <>
                <label className="field-label material-label">
                  {t("Surface", "材质")}
                </label>
                <div className="segmented">
                  {(["silk", "glass", "neon"] as const).map((m) => (
                    <button
                      key={m}
                      disabled={state.mode === "exporting"}
                      className={state.params.material === m ? "active" : ""}
                      onClick={() =>
                        runtimeRef.current?.setParams({ material: m })
                      }
                    >
                      {m === "silk"
                        ? t("Silk", "绸缎")
                        : m === "glass"
                          ? t("Glass", "玻璃")
                          : t("Neon", "霓虹")}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
          <div className="inspector-section sliders">
            <Slider
              label={t("Luminosity", "发光强度")}
              value={state.params.intensity}
              max={1.5}
              disabled={state.mode === "exporting"}
              onChange={(v) => runtimeRef.current?.setParams({ intensity: v })}
            />
            {state.scene === "ribbon" ? (
              <>
                <Slider
                  label={t("Ribbon width", "光带宽度")}
                  value={state.params.width}
                  disabled={state.mode === "exporting"}
                  onChange={(v) => runtimeRef.current?.setParams({ width: v })}
                />
                <Slider
                  label={t("Trail length", "拖尾长度")}
                  value={state.params.trail}
                  disabled={state.mode === "exporting"}
                  onChange={(v) => runtimeRef.current?.setParams({ trail: v })}
                />
              </>
            ) : null}
            {state.scene === "gravity" ? (
              <Slider
                label={t("Light trails", "光迹长度")}
                value={state.params.trail}
                disabled={state.mode === "exporting"}
                onChange={(v) => runtimeRef.current?.setParams({ trail: v })}
              />
            ) : null}
            {state.scene === "portal" ? (
              <>
                <Slider
                  label={t("Edge softness", "边缘柔和度")}
                  value={state.params.feather}
                  disabled={state.mode === "exporting"}
                  onChange={(v) =>
                    runtimeRef.current?.setParams({ feather: v })
                  }
                />
                <Slider
                  label={t("Flow speed", "流动速度")}
                  value={state.params.speed}
                  disabled={state.mode === "exporting"}
                  onChange={(v) => runtimeRef.current?.setParams({ speed: v })}
                />
              </>
            ) : null}
          </div>
          <div className="gesture-card">
            <Hand size={19} strokeWidth={1.3} />
            <span>
              {state.scene === "ribbon"
                ? t("Pinch to draw. Release to finish.", "捏合绘制，松手收笔。")
                : state.scene === "gravity"
                  ? t(
                      "Pinch to catch. Move, then release.",
                      "捏合抓取，移动后松手。",
                    )
                  : t(
                      "Move slowly. Let your outline lead.",
                      "缓慢移动，让轮廓引导画面。",
                    )}
              <small>
                {state.scene === "portal"
                  ? t(
                      "A person-shaped window into another world.",
                      "以身体为窗口，望向另一个世界。",
                    )
                  : t(
                      "Two hands. Twice the possibility.",
                      "双手创作，双倍可能。",
                    )}
              </small>
            </span>
          </div>
          <div className="inspector-spacer" />
          <label className="quality-picker">
            <span>{t("Render quality", "渲染质量")}</span>
            <select
              aria-label="Render quality"
              value={state.params.quality}
              disabled={state.mode === "exporting"}
              onChange={(e) =>
                runtimeRef.current?.setParams({
                  quality: e.target.value as typeof state.params.quality,
                })
              }
            >
              <option value="auto">{t("Auto", "自动")}</option>
              <option value="high">{t("High", "高")}</option>
              <option value="balanced">{t("Balanced", "均衡")}</option>
              <option value="low">{t("Low", "低")}</option>
            </select>
          </label>
          <button
            className="primary-button export-open"
            disabled={!state.ready || state.mode === "recording"}
            onClick={() => setModal("export")}
          >
            <ArrowDownToLine size={16} />
            {t("Export creation", "导出作品")}
            <ArrowUpRight size={15} />
          </button>
          <p className="export-hint">
            {t("Made by you. Ready for the world.", "由你创作，与你分享。")}
          </p>
        </aside>
      </main>
      <footer className="app-footer">
        <span>
          <ShieldCheck size={13} />
          {t(
            "Private by design. Camera pixels stay here.",
            "为隐私而设计，摄像头画面留在本机。",
          )}
        </span>
        <button
          disabled={
            offline.state === "loading" || offline.state === "unavailable"
          }
          title={offline.message}
          onClick={() => void run("", prepareOffline)}
        >
          <WifiOff size={12} />
          {offline.state === "ready"
            ? t("Available offline", "离线资源已就绪")
            : offline.state === "loading"
              ? `${t("Preparing offline", "准备离线资源")} ${Math.round(offline.progress * 100)}%`
              : t("Make available offline", "准备离线使用")}
        </button>
        <span className="footer-version">
          PRISM STAGE <span>1.0</span>
        </span>
      </footer>
      <input
        ref={videoInput}
        aria-label="Import local video"
        className="hidden-input"
        type="file"
        accept="video/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void run("video", () =>
              runtimeRef.current!.setSource("video", file),
            );
          e.target.value = "";
        }}
      />
      <input
        ref={projectInput}
        aria-label="Import project file"
        className="hidden-input"
        disabled={locked}
        type="file"
        accept=".prismstage,application/zip"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && !locked)
            void run("project", async () =>
              openProject(await decodeProject(file)),
            );
          e.target.value = "";
        }}
      />
      {state.error ? (
        <div className="error-banner" role="alert">
          <span>{state.error}</span>
          <button
            onClick={() =>
              void run("retry", () => runtimeRef.current!.retrySource())
            }
          >
            {t("Retry", "重试")}
          </button>
          <button
            aria-label="Dismiss error"
            onClick={() => runtimeRef.current?.clearError()}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      {modal ? (
        <Modal
          title={
            modal === "export"
              ? t("Give your creation a life outside.", "让作品，走出舞台。")
              : modal === "library"
                ? t("Your collection.", "你的作品库。")
                : modal === "save"
                  ? t("Keep this moment.", "保存这一刻。")
                  : t("A little motion goes a long way.", "从一个动作开始。")
          }
          onClose={() => {
            if (state.mode === "exporting") runtimeRef.current?.abortExport();
            setModal(null);
          }}
        >
          {modal === "save" ? (
            <>
              <p>
                {t(
                  "Save the movement and its look. Come back to make something new.",
                  "保存动作与外观，随时回来继续创作。",
                )}
              </p>
              <label className="modal-field">
                {t("Project name", "工程名称")}
                <input
                  autoFocus
                  maxLength={80}
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() => void run("project", exportProject)}
                >
                  <Download size={15} />
                  {t("Download project", "下载工程")}
                </button>
                <button
                  className="primary-button"
                  disabled={!!busy || !projectName.trim()}
                  onClick={() => void run("save", saveCurrent)}
                >
                  <Save size={15} />
                  {t("Save locally", "保存到本地")}
                </button>
              </div>
            </>
          ) : null}
          {modal === "library" ? (
            <>
              <div className="library-toolbar">
                <p>
                  {t(
                    "Saved in this browser. Download a project for a portable backup.",
                    "作品保存在此浏览器中，下载工程可作为便携备份。",
                  )}
                </p>
                <button
                  className="secondary-button"
                  onClick={() => projectInput.current?.click()}
                >
                  <Upload size={14} />
                  {t("Import project", "导入工程")}
                </button>
              </div>
              <div className="library-grid">
                {projects.map((p) => (
                  <div className="saved-project" key={p.id}>
                    <button
                      onClick={() =>
                        void run("load", async () => {
                          const project = await loadProject(p.id);
                          if (project) await openProject(project);
                        })
                      }
                    >
                      {p.thumbnail ? (
                        <img src={p.thumbnail} alt={p.name} />
                      ) : (
                        <SceneArt scene={p.scene} />
                      )}
                      <strong>{p.name}</strong>
                      <span>
                        {formatTime(p.duration)} ·{" "}
                        {SCENES.find((s) => s.id === p.scene)?.name}
                      </span>
                    </button>
                    <button
                      className="delete-project"
                      aria-label={`Delete ${p.name}`}
                      onClick={() =>
                        void run("delete", async () => {
                          await deleteProject(p.id);
                          setProjects(await listProjects());
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {!projects.length ? (
                <div className="empty-state">
                  <FolderOpen size={30} strokeWidth={1} />
                  <h3>
                    {t(
                      "Every collection starts with a little experiment.",
                      "每个作品库，都从一次小实验开始。",
                    )}
                  </h3>
                  <p>
                    {t(
                      "Record a take, then save your first study.",
                      "录下一段动作，保存你的第一件作品。",
                    )}
                  </p>
                </div>
              ) : null}
              <div className="example-row">
                <span>{t("OR OPEN AN EXAMPLE", "或者打开示例")}</span>
                {SCENES.map((s) => (
                  <button
                    className="text-button"
                    key={s.id}
                    onClick={() =>
                      void run("example", async () => {
                        const res = await fetch(
                          `${import.meta.env.BASE_URL}examples/${s.id}.prismstage`,
                        );
                        if (!res.ok)
                          throw new Error("Example could not be loaded.");
                        await openProject(
                          await decodeProject(await res.blob()),
                        );
                      })
                    }
                  >
                    {lang === "zh" ? s.zh : s.name}
                    <ArrowUpRight size={12} />
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {modal === "export" ? (
            <>
              <p>
                {t(
                  "Export the finished image, or replay your take as a short film.",
                  "导出完整画面，或将录制动作回放为一段短片。",
                )}
              </p>
              <div className="export-options">
                <button
                  className="export-option"
                  disabled={state.mode === "exporting"}
                  onClick={() =>
                    void run("png", async () =>
                      downloadBlob(
                        await runtimeRef.current!.capturePng(),
                        "prism-stage.png",
                      ),
                    )
                  }
                >
                  <Camera size={22} />
                  <strong>{t("Still image", "静态画面")}</strong>
                  <span>
                    PNG ·{" "}
                    {state.aspect === "landscape" ? "1280 × 720" : "720 × 1280"}
                  </span>
                  <Download size={16} />
                </button>
                <button
                  className="export-option"
                  disabled={!isTake || state.mode === "exporting" || !!busy}
                  onClick={() => void run("export", exportVideo)}
                >
                  <Film size={22} />
                  <strong>{t("Motion film", "动态短片")}</strong>
                  <span>
                    {isTake
                      ? `${(state.trimEnd - state.trimStart).toFixed(1)}s · ${t("silent", "无音频")}`
                      : t("Record a take first", "请先录制动作")}
                  </span>
                  {state.mode === "exporting" ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <ArrowUpRight size={16} />
                  )}
                </button>
              </div>
              {isTake ? (
                <div className="trim-controls">
                  <label>
                    <Scissors size={14} />
                    {t("Choose your moment", "截取精彩片段")}
                  </label>
                  <div>
                    <label>
                      {t("In", "起点")}
                      <input
                        aria-label="Trim start"
                        type="number"
                        min="0"
                        max={Math.max(0, state.trimEnd - 0.1)}
                        step="0.1"
                        disabled={state.mode === "exporting"}
                        value={Number(state.trimStart.toFixed(2))}
                        onChange={(e) =>
                          runtimeRef.current?.setTrim(
                            Number(e.target.value),
                            state.trimEnd,
                          )
                        }
                      />
                    </label>
                    <span>→</span>
                    <label>
                      {t("Out", "终点")}
                      <input
                        aria-label="Trim end"
                        type="number"
                        min={state.trimStart + 0.1}
                        max={state.duration}
                        step="0.1"
                        disabled={state.mode === "exporting"}
                        value={Number(state.trimEnd.toFixed(2))}
                        onChange={(e) =>
                          runtimeRef.current?.setTrim(
                            state.trimStart,
                            Number(e.target.value),
                          )
                        }
                      />
                    </label>
                  </div>
                </div>
              ) : null}
              {state.mode === "exporting" ? (
                <div className="export-progress">
                  <div
                    style={{
                      width: `${((state.time - state.trimStart) / (state.trimEnd - state.trimStart)) * 100}%`,
                    }}
                  />
                  <p>
                    {!state.playing && state.time <= state.trimStart
                      ? t("Preparing video export. Keep this tab in front.", "正在准备视频导出，请保持此标签页在前台。")
                      : t("Rendering your film. Keep this tab in front.", "正在渲染短片，请保持此标签页在前台。")}{" "}
                    {formatTime(state.time - state.trimStart)}
                  </p>
                  <button onClick={() => runtimeRef.current?.abortExport()}>
                    {t("Cancel", "取消")}
                  </button>
                </div>
              ) : null}
              {exportResult ? (
                <div className="export-result">
                  <video
                    src={exportResult.url}
                    controls
                    playsInline
                    aria-label="Exported film preview"
                  />
                  <a
                    className="primary-button"
                    href={exportResult.url}
                    download={`prism-stage.${exportResult.extension}`}
                  >
                    <Download size={16} />
                    {t("Download film", "下载短片")}
                    <span>
                      {(exportResult.blob.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                  </a>
                </div>
              ) : null}
              <div className="project-export-row">
                <div>
                  <strong>{t("Keep it editable", "保留可编辑工程")}</strong>
                  <small>
                    {t(
                      "Movement, look, and everything to replay.",
                      "包含动作、外观与完整回放所需的数据。",
                    )}
                  </small>
                </div>
                <button
                  className="secondary-button"
                  disabled={!isTake || state.mode === "exporting"}
                  onClick={() => void run("project", exportProject)}
                >
                  <Download size={14} />
                  .prismstage
                </button>
              </div>
              <small className="fine-print">
                {t(
                  "Video exports run in real time, up to 60 seconds. Camera pixels and audio are not included.",
                  "视频以实时速度导出，最长 60 秒。不包含摄像头原图与音频。",
                )}
              </small>
            </>
          ) : null}
          {modal === "help" ? (
            <>
              <div className="guide-grid">
                <div>
                  <span>01</span>
                  <h3>{t("Find your stage", "选择你的舞台")}</h3>
                  <p>
                    {t(
                      "Explore the demo, then enable your camera or import a video. For hands, keep both palms visible and try a relaxed pinch.",
                      "先体验演示，再开启摄像头或导入视频。保持双手在画面中，轻松捏合拇指与食指。",
                    )}
                  </p>
                </div>
                <div>
                  <span>02</span>
                  <h3>{t("Record the movement", "记录你的动作")}</h3>
                  <p>
                    {t(
                      "Press Record motion. Your stage starts fresh. Perform for up to 60 seconds, then finish the take.",
                      "点击录制动作，舞台将从初始状态开始。创作最长 60 秒，然后结束录制。",
                    )}
                  </p>
                </div>
                <div>
                  <span>03</span>
                  <h3>{t("Reimagine, then share", "重新设计，导出分享")}</h3>
                  <p>
                    {t(
                      "Replay, change the palette or material, and export your film. Save the project to keep it editable.",
                      "回放动作，更换颜色或材质，然后导出短片。保存工程，以便随时继续编辑。",
                    )}
                  </p>
                </div>
              </div>
              <div className="help-detail">
                <h3>{t("A few good things to know", "几个使用提示")}</h3>
                <p>
                  {t(
                    "Good light and a steady camera help. Tracking can lose fast or hidden fingers. The portal is an artistic person mask, not background reconstruction. Hand depth is an expressive virtual mapping.",
                    "光线充足、镜头稳定时效果更好。快速移动或遮挡手指会影响追踪。传送门使用艺术化人物蒙版，空间深度采用虚拟映射。",
                  )}
                </p>
                <p>
                  {t(
                    "Demo inputs are synthetic. Recorded projects keep motion or silhouettes, never original camera pixels. Local videos are decoded on your device.",
                    "演示输入为模拟动作。工程保留动作或轮廓，不保存摄像头原图。本地视频仅在你的设备上解码。",
                  )}
                </p>
                <div className="shortcut-row">
                  <kbd>Space</kbd>
                  {t("Play / pause", "播放 / 暂停")}
                  <kbd>R</kbd>
                  {t("Record / finish", "录制 / 结束")}
                  <kbd>Ctrl Z</kbd>
                  {t("Undo stroke", "撤销笔画")}
                </div>
                <label className="reduce-motion">
                  <input
                    type="checkbox"
                    checked={reduced}
                    onChange={(e) => {
                      setReduced(e.target.checked);
                      runtimeRef.current?.setReducedMotion(e.target.checked);
                    }}
                  />
                  {t(
                    "Reduce motion (pause demo autoplay)",
                    "减少动效（暂停演示自动播放）",
                  )}
                </label>
              </div>
              <div className="diagnostics">
                <span>
                  {t("Render", "渲染")} {state.fps} fps
                </span>
                <span>
                  {t("Vision", "视觉")} {state.visionFps.toFixed(1)} fps ·{" "}
                  {state.inferenceMs.toFixed(0)} ms
                </span>
                <span>
                  {state.delegate || "—"} · {state.quality}
                </span>
              </div>
            </>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
function Slider({
  label,
  value,
  max = 1,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  max?: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <label className="slider-field">
      <span>
        {label}
        <output>
          {Math.round((value / max) * 100)}
          <small>%</small>
        </output>
      </span>
      <input
        type="range"
        min="0.05"
        max={max}
        step="0.01"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={
          { "--progress": `${(value / max) * 100}%` } as React.CSSProperties
        }
      />
    </label>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab" && node) {
        const targets = Array.from(
          node.querySelectorAll<HTMLElement>(
            "button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),video[controls]",
          ),
        );
        const first = targets[0],
          last = targets.at(-1);
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === node)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-heading">
          <span className="eyebrow">PRISM STAGE / STUDIO</span>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
