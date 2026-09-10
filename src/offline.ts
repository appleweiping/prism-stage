export type OfflineState = {
  state: "unavailable" | "idle" | "loading" | "ready" | "error";
  progress: number;
  message: string;
};
export async function initOffline(
  onState: (s: OfflineState) => void,
): Promise<() => void> {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) {
    onState({
      state: "unavailable",
      progress: 0,
      message: "Available in the production build",
    });
    return () => {};
  }
  const listener = (event: MessageEvent) => {
    if (event.data?.type === "OFFLINE_STATUS") onState(event.data.status);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  try {
    const reg = await navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}sw.js`,
    );
    await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: "CHECK_OFFLINE" });
  } catch (error) {
    onState({ state: "error", progress: 0, message: String(error) });
  }
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
export async function prepareOffline() {
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage({ type: "PREPARE_OFFLINE" });
}
