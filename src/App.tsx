import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  Bot,
  Camera,
  ChevronRight,
  CircleDollarSign,
  ExternalLink,
  Gauge,
  History,
  ImageUp,
  LoaderCircle,
  ScanLine,
  Search,
  Square,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRunHistory, AnalysisResponse, DetectedItem, Stats } from "./types";

const EMPTY_STATS: Stats = {
  framesProcessed: 0,
  itemsIdentified: 0,
  searchesPerformed: 0,
  modelCalls: 0,
  lastUpdated: null,
};
const MAX_CONCURRENT_FRAMES = 5;

type View = "scan" | "history";
type Source = "camera" | "video" | "image";

async function fetchStats(): Promise<Stats> {
  const response = await fetch("/api/stats");
  if (!response.ok) throw new Error("Could not load processing statistics.");
  return response.json();
}

async function fetchItems(): Promise<DetectedItem[]> {
  const response = await fetch("/api/items");
  if (!response.ok) throw new Error("Could not load saved finds.");
  return response.json();
}

async function fetchFrameItems(itemId: string): Promise<DetectedItem[]> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`);
  if (!response.ok) throw new Error("Could not load this find.");
  return response.json();
}

async function fetchAgentRun(itemId: string): Promise<AgentRunHistory> {
  const response = await fetch(`/api/agent-runs/by-item/${encodeURIComponent(itemId)}`);
  const body = (await response.json()) as AgentRunHistory | { error?: string };
  if (!response.ok) throw new Error("error" in body && body.error ? body.error : "Could not load agent activity.");
  return body as AgentRunHistory;
}

export default function App({ children }: { children?: React.ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const intervalRef = useRef<number | null>(null);
  const inFlightRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const streamItemTokenRef = useRef(0);
  const streamQueueRef = useRef<DetectedItem[]>([]);
  const streamTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scanIntervalSecondsRef = useRef(2);
  const [source, setSource] = useState<Source>("camera");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [liveItems, setLiveItems] = useState<DetectedItem[]>([]);
  const [streamItemTokens, setStreamItemTokens] = useState<Record<string, number>>({});
  const [selectedItem, setSelectedItem] = useState<DetectedItem | null>(null);
  const [selectedFrameItems, setSelectedFrameItems] = useState<DetectedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("Camera ready");
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("off");
  const [stillPreviewUrl, setStillPreviewUrl] = useState<string | null>(null);
  const [snapshotFlash, setSnapshotFlash] = useState(0);
  const [scanIntervalSeconds, setScanIntervalSeconds] = useState(2);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const findPath = location.pathname.split("/");
  const itemId = findPath[1] === "finds" && findPath[2] ? decodeURIComponent(findPath[2]) : null;
  const activityOpen = Boolean(itemId && findPath[3] === "activity");
  const view: View = location.pathname === "/history" || (itemId && location.search.from !== "scan")
    ? "history"
    : "scan";
  const { data: stats = EMPTY_STATS } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  const { data: historyItems = [] } = useQuery({ queryKey: ["items"], queryFn: fetchItems });
  const { data: routedFrameItems = [] } = useQuery({
    queryKey: ["frame-items", itemId],
    queryFn: () => fetchFrameItems(itemId!),
    enabled: Boolean(itemId),
  });

  const refreshHistory = useCallback(
    async () => queryClient.invalidateQueries({ queryKey: ["items"] }),
    [queryClient],
  );

  useEffect(() => {
    return () => {
      stopMedia();
      void audioContextRef.current?.close();
    };
  }, []);

  const startItemStream = useCallback(() => {
    if (streamTimerRef.current !== null) return;

    const revealNext = () => {
      const nextItem = streamQueueRef.current.shift();
      if (!nextItem) {
        streamTimerRef.current = null;
        return;
      }

      const token = ++streamItemTokenRef.current;
      setStreamItemTokens((current) => ({ ...current, [nextItem.id]: token }));
      setLiveItems((current) => [nextItem, ...current.filter((item) => item.id !== nextItem.id)].slice(0, 100));
      streamTimerRef.current = window.setTimeout(revealNext, 500);
    };

    revealNext();
  }, []);

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new window.AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const unlockAudio = useCallback(() => {
    const context = getAudioContext();
    if (context.state === "suspended") void context.resume();
  }, [getAudioContext]);

  useEffect(() => {
    if (!itemId) {
      setSelectedItem(null);
      setSelectedFrameItems([]);
      return;
    }
    const availableItems = [...routedFrameItems, ...liveItems, ...historyItems];
    const routeItem = availableItems.find((item) => item.id === itemId);
    if (!routeItem) return;
    setSelectedItem(routeItem);
    setSelectedFrameItems(
      routedFrameItems.length > 0
        ? routedFrameItems
        : availableItems.filter((item) => item.thumbnailUrl === routeItem.thumbnailUrl),
    );
  }, [historyItems, itemId, liveItems, routedFrameItems]);

  const playFoundSound = useCallback(() => {
    const context = getAudioContext();
    if (context.state === "suspended") void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(720, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1_080, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.24);
  }, [getAudioContext]);

  const playSnapshotFeedback = useCallback(() => {
    setSnapshotFlash((current) => current + 1);
    const context = getAudioContext();
    if (context.state === "suspended") void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(1_800, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(700, context.currentTime + 0.07);
    gain.gain.setValueAtTime(0.1, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.09);
  }, [getAudioContext]);

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setCameraDevices(devices.filter((device) => device.kind === "videoinput"));
  }, []);

  useEffect(() => {
    void refreshCameras();
    navigator.mediaDevices?.addEventListener("devicechange", refreshCameras);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshCameras);
  }, [refreshCameras]);

  const submitBlob = useCallback(
    async (activeSessionId: string, blob: Blob) => {
      if (inFlightRef.current >= MAX_CONCURRENT_FRAMES) return;
      inFlightRef.current += 1;
      setInFlight(inFlightRef.current);
      try {
        const form = new FormData();
        form.set("sessionId", activeSessionId);
        form.set("capturedAt", new Date().toISOString());
        form.set("image", blob, "frame.jpg");
        const response = await fetch("/api/analyze", { method: "POST", body: form });
        const body = (await response.json()) as AnalysisResponse | { error?: string };
        if (!response.ok) throw new Error("error" in body ? body.error : "Frame analysis failed");

        const result = body as AnalysisResponse;
        queryClient.setQueryData(["stats"], result.stats);
        if (result.items.length > 0) {
          streamQueueRef.current.push(...result.items);
          startItemStream();
          playFoundSound();
          void refreshHistory();
        }
        setError(null);
      } catch (frameError) {
        setError(frameError instanceof Error ? frameError.message : "Frame analysis failed");
      } finally {
        inFlightRef.current -= 1;
        setInFlight(inFlightRef.current);
      }
    },
    [playFoundSound, queryClient, refreshHistory, startItemStream],
  );

  const submitFrame = useCallback(
    async (activeSessionId: string, onCaptured?: () => void) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || inFlightRef.current >= MAX_CONCURRENT_FRAMES) return;
      if (video.currentTime === lastVideoTimeRef.current) return;
      lastVideoTimeRef.current = video.currentTime;

      const scale = Math.min(1, 960 / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      onCaptured?.();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.76));
      if (!blob) return;
      await submitBlob(activeSessionId, blob);
    },
    [submitBlob],
  );

  const beginSession = useCallback(
    async (nextSource: Source, sourceName?: string) => {
      const id = crypto.randomUUID();
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, sourceType: nextSource, sourceName }),
      });
      if (!response.ok) throw new Error("Could not start a scan session.");
      setSessionId(id);
      setSource(nextSource);
      setLiveItems([]);
      return id;
    },
    [],
  );

  const openCamera = async (deviceId?: string): Promise<string> => {
    stopMedia();
    setStillPreviewUrl(null);
    const videoConstraint = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
    streamRef.current = stream;
    if (!videoRef.current) throw new Error("Camera preview is unavailable.");
    videoRef.current.src = "";
    videoRef.current.srcObject = stream;
    videoRef.current.muted = true;
    await videoRef.current.play();
    const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? "";
    setSelectedCameraId(activeDeviceId || "off");
    setSourceLabel(stream.getVideoTracks()[0]?.label || "Camera");
    await refreshCameras();
    return beginSession("camera");
  };

  const ensureCamera = async (): Promise<string> => {
    if (streamRef.current && source === "camera" && sessionId) return sessionId;
    return openCamera(selectedCameraId === "off" ? undefined : selectedCameraId);
  };

  const startLiveScan = (activeSessionId: string) => {
    setScanning(true);
    intervalRef.current = window.setInterval(
      () => void submitFrame(activeSessionId, playSnapshotFeedback),
      scanIntervalSecondsRef.current * 1_000,
    );
    window.setTimeout(() => void submitFrame(activeSessionId, playSnapshotFeedback), 350);
  };

  const changeScanInterval = (seconds: number) => {
    scanIntervalSecondsRef.current = seconds;
    setScanIntervalSeconds(seconds);
    if (!scanning || !sessionId) return;
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(
      () => void submitFrame(sessionId, playSnapshotFeedback),
      seconds * 1_000,
    );
  };

  const toggleLiveScan = async () => {
    unlockAudio();
    try {
      if (scanning) {
        stopScan();
        return;
      }
      const id = await ensureCamera();
      startLiveScan(id);
    } catch (cameraError) {
      setError(cameraError instanceof Error ? cameraError.message : "Camera access failed");
    }
  };

  const takeSnapshot = async () => {
    unlockAudio();
    try {
      const id = await ensureCamera();
      await submitFrame(id, playSnapshotFeedback);
    } catch (cameraError) {
      setError(cameraError instanceof Error ? cameraError.message : "Camera snapshot failed");
    }
  };

  const selectCamera = async (deviceId: string) => {
    if (deviceId === "off") {
      stopMedia();
      setSelectedCameraId("off");
      setSessionId(null);
      setSourceLabel("Camera off");
      return;
    }
    const resumeScanning = scanning;
    try {
      const id = await openCamera(deviceId);
      if (resumeScanning) startLiveScan(id);
    } catch (cameraError) {
      setSelectedCameraId("off");
      setError(cameraError instanceof Error ? cameraError.message : "Camera access failed");
    }
  };

  const loadVideo = async (file: File) => {
    unlockAudio();
    try {
      stopMedia();
      setSelectedCameraId("off");
      setStillPreviewUrl(null);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      if (!videoRef.current) return;
      videoRef.current.srcObject = null;
      videoRef.current.src = url;
      videoRef.current.muted = true;
      videoRef.current.loop = false;
      await videoRef.current.play();
      setSourceLabel(file.name);
      const id = await beginSession("video", file.name);
      startLiveScan(id);
    } catch (videoError) {
      setError(videoError instanceof Error ? videoError.message : "Video could not be loaded");
    }
  };

  const loadImage = async (file: File) => {
    unlockAudio();
    try {
      stopMedia();
      setSelectedCameraId("off");
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setStillPreviewUrl(url);
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Image canvas is unavailable.");
      const scale = Math.min(1, 960 / image.naturalWidth);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image canvas is unavailable.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      playSnapshotFeedback();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error("The selected image could not be prepared.");
      setSourceLabel(file.name);
      const id = await beginSession("image", file.name);
      await submitBlob(id, blob);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : "Image could not be loaded");
    }
  };

  const stopScan = () => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    intervalRef.current = null;
    setScanning(false);
  };

  function stopMedia() {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    intervalRef.current = null;
    setScanning(false);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    lastVideoTimeRef.current = -1;
  }

  const displayedItems = view === "scan" ? liveItems : historyItems;

  return (
    <div className="app-shell">
      <main>
        <section className="stats-ribbon" aria-label="Live processing statistics">
          <Stat label="Frames" value={stats.framesProcessed} />
          <Stat label="Items" value={stats.itemsIdentified} />
          <Stat label="Searches" value={stats.searchesPerformed} />
          <Stat label="Model calls" value={stats.modelCalls} />
        </section>

        {view === "scan" ? (
          <>
            <section className="camera-stage">
              <video ref={videoRef} playsInline onEnded={stopScan} />
              {stillPreviewUrl && <img className="still-preview" src={stillPreviewUrl} alt="Uploaded frame" />}
              {snapshotFlash > 0 && <span key={snapshotFlash} className="snapshot-flash" aria-hidden="true" />}
              {!sessionId && (
                <div className="camera-empty">
                  <div className="reticle"><ScanLine size={54} /></div>
                </div>
              )}
              {sessionId && (
                <div className="camera-hud">
                  <span className="hud-source">
                    {source === "camera" ? <Camera size={14} /> : source === "image" ? <ImageUp size={14} /> : <Video size={14} />}
                    {sourceLabel}
                  </span>
                  <span className="hud-throughput">
                    {inFlight > 0 ? <LoaderCircle className="spin" size={14} /> : <Gauge size={14} />}
                    {inFlight} / {MAX_CONCURRENT_FRAMES} active
                  </span>
                </div>
              )}
              <canvas ref={canvasRef} hidden />
            </section>

            <section className="scan-actions">
              <label className="camera-select-control">
                <Camera size={18} />
                <select
                  value={selectedCameraId}
                  onChange={(event) => void selectCamera(event.target.value)}
                  aria-label="Select camera"
                >
                  <option value="off">Camera off</option>
                  {cameraDevices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <button className={`primary-action ${scanning ? "stop" : ""}`} onClick={() => void toggleLiveScan()}>
                {scanning ? <Square size={15} fill="currentColor" /> : <ScanLine size={18} />}
                {scanning ? "Stop live" : "Start live"}
              </button>
              <button className="secondary-action" onClick={() => void takeSnapshot()}>
                <Camera size={18} /> Snapshot
              </button>
              <label className="upload-action" title="Upload a photo or video" aria-label="Upload a photo or video">
                <ImageUp size={19} />
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/*,video/mp4,video/quicktime,video/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file?.type.startsWith("image/")) void loadImage(file);
                    else if (file) void loadVideo(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <div className="scan-frequency">
                <span>1s</span>
                <input
                  type="range"
                  min="1"
                  max="20"
                  step="1"
                  value={scanIntervalSeconds}
                  onChange={(event) => changeScanInterval(Number(event.target.value))}
                  aria-label={`Scan every ${scanIntervalSeconds} seconds`}
                />
                <span>20s</span>
                <strong>Every {scanIntervalSeconds}s</strong>
              </div>
            </section>
          </>
        ) : (
          <section className="history-heading">
            <div>
              <p className="eyebrow">All-time finds</p>
              <h2>Saved inventory</h2>
            </div>
            <button className="icon-button" onClick={() => void refreshHistory()} aria-label="Refresh history">
              <History size={20} />
            </button>
          </section>
        )}

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
          </div>
        )}

        <section className="finds-section">
          <div className="item-feed">
            {displayedItems.map((item) => (
              <ItemCard
                key={`${item.id}-${view === "scan" ? streamItemTokens[item.id] ?? "stable" : "history"}`}
                item={item}
                animate={view === "scan"}
                onSelect={(selected) => {
                  setSelectedItem(selected);
                  setSelectedFrameItems(
                    displayedItems.filter((candidate) => candidate.thumbnailUrl === selected.thumbnailUrl),
                  );
                  void navigate({
                    to: "/finds/$itemId",
                    params: { itemId: selected.id },
                    search: { from: view },
                  });
                }}
              />
            ))}
            {displayedItems.length === 0 && (
              <div className="empty-feed">
                <CircleDollarSign size={36} />
                {view === "history" && <p>No saved finds yet.</p>}
              </div>
            )}
          </div>
        </section>
      </main>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <Link to="/scan" className={view === "scan" ? "active" : ""}>
          <ScanLine /> <span>Scan</span>
        </Link>
        <Link to="/history" className={view === "history" ? "active" : ""} onClick={() => void refreshHistory()}>
          <Archive /> <span>History</span>
        </Link>
      </nav>

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          frameItems={selectedFrameItems.length > 0 ? selectedFrameItems : [selectedItem]}
          onSelect={(nextItem) => {
            setSelectedItem(nextItem);
            void navigate(
              activityOpen
                ? {
                    to: "/finds/$itemId/activity",
                    params: { itemId: nextItem.id },
                    search: { from: view },
                    replace: true,
                  }
                : {
                    to: "/finds/$itemId",
                    params: { itemId: nextItem.id },
                    search: { from: view },
                    replace: true,
                  },
            );
          }}
          activityOpen={activityOpen}
          onToggleActivity={() => {
            void navigate(
              activityOpen
                ? { to: "/finds/$itemId", params: { itemId: selectedItem.id }, search: { from: view } }
                : { to: "/finds/$itemId/activity", params: { itemId: selectedItem.id }, search: { from: view } },
            );
          }}
          onClose={() => {
            void navigate({ to: view === "scan" ? "/scan" : "/history" });
          }}
        />
      )}
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function ItemCard({
  item,
  animate,
  onSelect,
}: {
  item: DetectedItem;
  animate?: boolean;
  onSelect: (item: DetectedItem) => void;
}) {
  return (
    <button
      className={`item-card${animate ? " stream-in" : ""}`}
      onClick={() => onSelect(item)}
    >
      <div className="thumbnail-wrap">
        <ItemThumbnail item={item} />
        <span className="confidence">{Math.round(item.confidence * 100)}%</span>
      </div>
      <div className="item-copy">
        <div className="item-meta">
          <span>{item.category}</span>
          {item.duplicate && <span className="repeat-badge">Seen {item.seenCount}×</span>}
          <RelativeTime timestamp={item.firstSeenAt} />
        </div>
        <h3>{item.name}</h3>
        <p>{item.valueSummary}</p>
        <div className="price-row">
          <strong>{formatRange(item)}</strong>
          {item.observedPriceCents !== null && <span>Tag {money(item.observedPriceCents, item.currency)}</span>}
        </div>
      </div>
      <ChevronRight className="card-chevron" size={20} />
    </button>
  );
}

function RelativeTime({ timestamp }: { timestamp: string }) {
  const [now, setNow] = useState(Date.now());
  const foundAt = Date.parse(timestamp);
  const ageMs = Math.max(0, now - foundAt);

  useEffect(() => {
    const refreshMs = ageMs < 60_000 ? 1_000 : ageMs < 3_600_000 ? 60_000 : 3_600_000;
    const timer = window.setTimeout(() => setNow(Date.now()), refreshMs);
    return () => window.clearTimeout(timer);
  }, [ageMs]);

  return (
    <time className="found-time" dateTime={timestamp} title={new Date(foundAt).toLocaleString()}>
      {formatRelativeTime(ageMs)}
    </time>
  );
}

function formatRelativeTime(ageMs: number) {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function ItemDetail({
  item,
  frameItems,
  activityOpen,
  onToggleActivity,
  onSelect,
  onClose,
}: {
  item: DetectedItem;
  frameItems: DetectedItem[];
  activityOpen: boolean;
  onToggleActivity: () => void;
  onSelect: (item: DetectedItem) => void;
  onClose: () => void;
}) {
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const frameListRef = useRef<HTMLDivElement>(null);
  const frameItemRefs = useRef(new Map<string, HTMLButtonElement>());
  const highlightedItemId = hoveredItemId ?? item.id;
  const marketEvidence = collectMarketEvidence(item);

  useEffect(() => {
    if (!hoveredItemId) return;
    const list = frameListRef.current;
    const matchedItem = frameItemRefs.current.get(hoveredItemId);
    if (!list || !matchedItem) return;

    const itemLeft = matchedItem.offsetLeft;
    const itemRight = itemLeft + matchedItem.offsetWidth;
    const visibleLeft = list.scrollLeft;
    const visibleRight = visibleLeft + list.clientWidth;
    if (itemLeft >= visibleLeft && itemRight <= visibleRight) return;

    const centeredLeft = matchedItem.offsetLeft - (list.clientWidth - matchedItem.offsetWidth) / 2;
    list.scrollTo({ left: centeredLeft, behavior: "instant" });
  }, [hoveredItemId]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <article className="detail-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close"><X /></button>
        <div className="detail-visual">
          <AnnotatedImage
            key={item.thumbnailUrl}
            items={frameItems}
            activeItemId={highlightedItemId}
            onHoverItem={setHoveredItemId}
          />
        </div>
        <div className="detail-content">
          <p className="eyebrow">{frameItems.length} item{frameItems.length === 1 ? "" : "s"} found in this frame</p>
          <div ref={frameListRef} className="frame-find-list">
            {frameItems.map((frameItem) => (
              <button
                key={frameItem.id}
                ref={(element) => {
                  if (element) frameItemRefs.current.set(frameItem.id, element);
                  else frameItemRefs.current.delete(frameItem.id);
                }}
                className={frameItem.id === highlightedItemId ? "active" : ""}
                onClick={() => onSelect(frameItem)}
                onMouseEnter={() => setHoveredItemId(frameItem.id)}
                onMouseLeave={() => setHoveredItemId(null)}
              >
                <span>{frameItem.category}</span>
                <strong>{frameItem.name}</strong>
                <b>{formatRange(frameItem)}</b>
              </button>
            ))}
          </div>
          <button className="agent-activity-toggle" onClick={onToggleActivity}>
            <Bot size={17} /> {activityOpen ? "Back to find" : "Agent activity"}
          </button>
          {activityOpen ? (
            <AgentActivity itemId={item.id} />
          ) : (
            <>
              <p className="eyebrow">{item.category} · {Math.round(item.confidence * 100)}% confidence</p>
              <h2>{item.name}</h2>
              <p className="detail-description">{item.description}</p>
              <div className="value-hero">
                <span>Estimated resale</span>
                <strong>{formatRange(item)}</strong>
                <p>{item.valueSummary}</p>
              </div>
              <a
                className="lens-search-link"
                href={`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(new URL(item.thumbnailUrl, window.location.origin).href)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Search size={17} /> Search full frame with Google Lens <ExternalLink size={15} />
              </a>
              {marketEvidence.length > 0 && (
                <section className="comparables">
                  <h3>Sold comps & web results</h3>
                  {marketEvidence.map((comparable, index) => {
                    const content = (
                      <>
                        <span className={`comp-type ${comparable.type}`}>{comparable.type}</span>
                        <span>{comparable.title}</span>
                        <strong>{comparable.priceCents === null ? "—" : money(comparable.priceCents, comparable.currency)}</strong>
                        {comparable.url && <ExternalLink size={15} />}
                      </>
                    );
                    return comparable.url ? (
                      <a key={`${comparable.title}-${index}`} href={comparable.url} target="_blank" rel="noreferrer">{content}</a>
                    ) : (
                      <div key={`${comparable.title}-${index}`}>{content}</div>
                    );
                  })}
                </section>
              )}
              <dl className="facts">
                <div><dt>Brand</dt><dd>{item.brand ?? "Unknown"}</dd></div>
                <div><dt>Model</dt><dd>{item.model ?? "Unknown"}</dd></div>
                <div><dt>Condition</dt><dd>{item.condition}</dd></div>
                <div><dt>Seen</dt><dd>{item.seenCount} time{item.seenCount === 1 ? "" : "s"}</dd></div>
              </dl>
            </>
          )}
        </div>
      </article>
    </div>
  );
}

function AgentActivity({ itemId }: { itemId: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["agent-run", itemId],
    queryFn: () => fetchAgentRun(itemId),
    retry: false,
  });

  if (isPending) {
    return <div className="agent-activity-state"><LoaderCircle className="spin" /> Loading activity</div>;
  }
  if (error || !data) {
    return <div className="agent-activity-state error">{error instanceof Error ? error.message : "Agent activity unavailable."}</div>;
  }

  return (
    <section className="agent-activity">
      <header>
        <div>
          <span>{data.model}</span>
          <strong>{(data.latencyMs / 1_000).toFixed(1)}s</strong>
        </div>
        <div>
          <span>Calls</span>
          <strong>{data.modelCalls}</strong>
        </div>
        <div>
          <span>Searches</span>
          <strong>{data.searchesPerformed}</strong>
        </div>
        <div>
          <span>Items</span>
          <strong>{data.itemCount}</strong>
        </div>
      </header>

      <AuditBlock title="Agent instructions" value={data.instructions} open />
      <AuditBlock title="Input" value={data.input} open />

      <div className="agent-timeline">
        {data.events.map((event) => (
          <article key={`${event.sequence}-${event.type}`}>
            <span className="timeline-index">{event.sequence + 1}</span>
            <div>
              <h4>{event.title}</h4>
              <pre>{prettyAuditValue(event.data)}</pre>
            </div>
          </article>
        ))}
        {data.events.length === 0 && <p>No agent events were recorded.</p>}
      </div>

      <AuditBlock title={`Raw model responses · ${data.rawResponses.length}`} value={data.rawResponses} />
      <AuditBlock title="Final structured output" value={data.output} />
      <AuditBlock title="Usage" value={data.usage} />
    </section>
  );
}

function AuditBlock({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return (
    <details className="audit-block" open={open}>
      <summary>{title}</summary>
      <pre>{prettyAuditValue(value)}</pre>
    </details>
  );
}

function prettyAuditValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ItemThumbnail({ item }: { item: DetectedItem }) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const box = item.boundingBox;
  const crop = box && imageSize ? paddedCrop(box, imageSize) : null;

  return (
    <>
      <img
        className={crop ? "thumbnail-source is-cropped" : "thumbnail-source"}
        src={item.thumbnailUrl}
        alt=""
        loading="lazy"
        onLoad={(event) => {
          const image = event.currentTarget;
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
      />
      {crop && imageSize && (
        <svg className="cropped-thumbnail" viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <image href={item.thumbnailUrl} width={imageSize.width} height={imageSize.height} />
        </svg>
      )}
    </>
  );
}

function paddedCrop(
  box: NonNullable<DetectedItem["boundingBox"]>,
  imageSize: { width: number; height: number },
) {
  const x = (box.xMin / 1000) * imageSize.width;
  const y = (box.yMin / 1000) * imageSize.height;
  const width = ((box.xMax - box.xMin) / 1000) * imageSize.width;
  const height = ((box.yMax - box.yMin) / 1000) * imageSize.height;
  const paddingX = Math.max(width * 0.18, imageSize.width * 0.02);
  const paddingY = Math.max(height * 0.18, imageSize.height * 0.02);
  const cropX = Math.max(0, x - paddingX);
  const cropY = Math.max(0, y - paddingY);
  return {
    x: cropX,
    y: cropY,
    width: Math.min(imageSize.width - cropX, width + paddingX * 2),
    height: Math.min(imageSize.height - cropY, height + paddingY * 2),
  };
}

function AnnotatedImage({
  items,
  activeItemId,
  onHoverItem,
}: {
  items: DetectedItem[];
  activeItemId: string;
  onHoverItem: (itemId: string | null) => void;
}) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const imageUrl = items[0]?.thumbnailUrl;

  return (
    <div className="annotated-image">
      <img
        src={imageUrl}
        alt=""
        onLoad={(event) => {
          const image = event.currentTarget;
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
      />
      {imageSize && (
        <svg
          className="item-box-overlay"
          viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {items.map((frameItem) => {
            const box = frameItem.boundingBox;
            if (!box) return null;
            return (
              <rect
                key={frameItem.id}
                className={frameItem.id === activeItemId ? "active" : ""}
                x={(box.xMin / 1000) * imageSize.width}
                y={(box.yMin / 1000) * imageSize.height}
                width={((box.xMax - box.xMin) / 1000) * imageSize.width}
                height={((box.yMax - box.yMin) / 1000) * imageSize.height}
                rx="5"
                vectorEffect="non-scaling-stroke"
                onMouseEnter={() => onHoverItem(frameItem.id)}
                onMouseLeave={() => onHoverItem(null)}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

function formatRange(item: DetectedItem): string {
  if (item.estimatedLowCents === null && item.estimatedHighCents === null) return "Value pending";
  if (item.estimatedLowCents === item.estimatedHighCents || item.estimatedHighCents === null) {
    return money(item.estimatedLowCents ?? item.estimatedHighCents ?? 0, item.currency);
  }
  return `${money(item.estimatedLowCents ?? 0, item.currency)}–${money(item.estimatedHighCents, item.currency)}`;
}

function collectMarketEvidence(item: DetectedItem) {
  const evidence: Array<{
    title: string;
    url: string | null;
    priceCents: number | null;
    currency: string;
    type: "retail" | "active" | "sold" | "web";
  }> = item.comparables.map((comparable) => ({ ...comparable }));
  const knownUrls = new Set(evidence.map((entry) => entry.url).filter(Boolean));
  const markdownLink = /\[([^\]]+)]\((https?:\/\/[^)]+)\)/g;
  for (const match of item.valueSummary.matchAll(markdownLink)) {
    const [, title, url] = match;
    if (!url || knownUrls.has(url)) continue;
    evidence.push({ title: title || "Web result", url, priceCents: null, currency: item.currency, type: "web" });
    knownUrls.add(url);
  }
  return evidence;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
