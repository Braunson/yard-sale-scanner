import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  Bot,
  Camera,
  ChevronRight,
  CircleDollarSign,
  Download,
  ExternalLink,
  Gauge,
  Globe,
  History,
  ImageUp,
  LoaderCircle,
  ScanLine,
  Search,
  Settings,
  Square,
  Store,
  Trash2,
  Video,
  X,
  Zap,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { gateFrame, sellableDetections } from "./detection";
import { detectVideoFrame, loadDetector } from "./detector";
import { loadBarcodeReader, readBarcodes } from "./barcodes";
import { MARKETS } from "./markets";
import { mergeTracks, seedTracks, type Track, TRACK_MAX_SEED_DELAY_MS, updateTracks } from "./tracking";
import { compStats, MIN_MATCH_SCORE, type PriceStats } from "./comps";
import { DEFAULT_OFFER_TARGETS, localResaleCents, offerAdvice, type OfferTargets, saleOutlook } from "./pricing";
import type {
  AgentRunHistory,
  AnalysisEvent,
  Comparable,
  DetectedItem,
  DeviceBarcode,
  DeviceDetection,
  HistoryPage,
  Market,
  Stats,
} from "./types";

const EMPTY_STATS: Stats = {
  framesProcessed: 0,
  itemsIdentified: 0,
  searchesPerformed: 0,
  modelCalls: 0,
  lastUpdated: null,
};
const DEFAULT_MAX_CONCURRENT_FRAMES = 5;
const MAX_CONCURRENT_FRAMES_SETTING = 100;
const FIND_CRITERIA_STORAGE_KEY = "yard-sale-find-criteria";
const DEVICE_DETECTION_STORAGE_KEY = "yard-sale-device-detection";
const MARKET_STORAGE_KEY = "yard-sale-market";
const OFFER_TARGETS_STORAGE_KEY = "yard-sale-offer-targets";
const BARCODE_INTERVAL_MS = 700;
/** A barcode stays attached to captures this long after it was last read. */
const BARCODE_TTL_MS = 3_000;
const DETECTION_INTERVAL_MS = 200;
/** A still scene is re-sent after this long, because COCO does not know many sale items. */
const MAX_QUIET_MS = 20_000;
const FIND_CRITERIA_PRESETS = [
  { label: "Vintage tees", value: "Vintage band tees worth more than $40" },
  { label: "Modern electronics", value: "Electronics that are still modern enough to use" },
  { label: "Designer goods", value: "Authentic designer clothing, shoes, bags, and accessories with strong resale value" },
  { label: "Collectibles", value: "Vintage toys, trading cards, figurines, and collectibles worth more than $30" },
  { label: "Quality cookware", value: "High-quality cookware, cast iron, knives, and small kitchen appliances worth reselling" },
  { label: "Rare media", value: "Rare, collectible, or out-of-print books, records, CDs, and physical media" },
];

type View = "scan" | "history";
type Source = "camera" | "video" | "image";
type DetectorStatus = "off" | "loading" | "ready" | "failed";

const OfferTargetsContext = createContext<OfferTargets>(DEFAULT_OFFER_TARGETS);
/** One shared empty list, so an effect that depends on a loading query does not run on every render. */
const NO_ITEMS: DetectedItem[] = [];

async function readAnalysisStream(body: ReadableStream<Uint8Array>, onEvent: (event: AnalysisEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split("\n");
      buffered = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as AnalysisEvent;
        if (event.type === "done" || event.type === "error") finished = true;
        onEvent(event);
      }
      if (done) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!finished) throw new Error("The connection closed before analysis finished.");
}

async function fetchStats(): Promise<Stats> {
  const response = await fetch("/api/stats");
  if (!response.ok) throw new Error("Could not load processing statistics.");
  return response.json();
}

async function fetchItems(search: string, cursor: string | null, signal: AbortSignal): Promise<HistoryPage> {
  const params = new URLSearchParams({ q: search });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/items?${params}`, { signal });
  if (!response.ok) throw new Error("Could not load saved finds.");
  return response.json();
}

function useHistory(search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["items", search],
    queryFn: ({ pageParam, signal }) => fetchItems(search, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
  });
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

async function deleteFindRequest(itemId: string): Promise<void> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Could not delete this find.");
}

async function deleteAllFindsRequest(): Promise<void> {
  const response = await fetch("/api/items", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not delete all finds.");
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
  const [findCriteria, setFindCriteria] = useState(() =>
    window.localStorage.getItem(FIND_CRITERIA_STORAGE_KEY) ?? "",
  );
  const findCriteriaRef = useRef(findCriteria);
  const [source, setSource] = useState<Source>("camera");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  /** True after an uploaded video plays to its end; the detector stops on its last frame. */
  const [mediaEnded, setMediaEnded] = useState(false);
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
  const [maxConcurrentFrames, setMaxConcurrentFrames] = useState(() => {
    const saved = Number(window.localStorage.getItem("yard-sale-max-concurrent-frames"));
    return Number.isInteger(saved) && saved >= 1 && saved <= MAX_CONCURRENT_FRAMES_SETTING
      ? saved
      : DEFAULT_MAX_CONCURRENT_FRAMES;
  });
  const maxConcurrentFramesRef = useRef(maxConcurrentFrames);
  const [deviceDetectionEnabled, setDeviceDetectionEnabled] = useState(
    () => window.localStorage.getItem(DEVICE_DETECTION_STORAGE_KEY) !== "off",
  );
  const deviceDetectionEnabledRef = useRef(deviceDetectionEnabled);
  const [detectorStatus, setDetectorStatus] = useState<DetectorStatus>("off");
  const [liveDetections, setLiveDetections] = useState<{
    detections: DeviceDetection[];
    tracks: Track[];
    width: number;
    height: number;
    unitsPerPixel: number;
  } | null>(null);
  const latestDetectionsRef = useRef<DeviceDetection[] | null>(null);
  const lastSentDetectionsRef = useRef<DeviceDetection[] | null>(null);
  const lastSentAtRef = useRef(0);
  const [skippedFrames, setSkippedFrames] = useState(0);
  const [market, setMarket] = useState<Market>(() =>
    window.localStorage.getItem(MARKET_STORAGE_KEY) === "CA" ? "CA" : "US",
  );
  const marketRef = useRef(market);
  const [offerTargets, setOfferTargets] = useState<OfferTargets>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(OFFER_TARGETS_STORAGE_KEY) ?? "null") as Partial<OfferTargets> | null;
      if (saved && Number.isFinite(saved.minProfitCents) && Number.isFinite(saved.minRoi)) {
        return {
          minProfitCents: Math.min(10_000, Math.max(0, Math.round(saved.minProfitCents!))),
          minRoi: Math.min(5, Math.max(0, saved.minRoi!)),
        };
      }
    } catch {
      // Fall through to the defaults when the saved value is not valid JSON.
    }
    return DEFAULT_OFFER_TARGETS;
  });
  const latestBarcodesRef = useRef<{ codes: DeviceBarcode[]; at: number }>({ codes: [], at: 0 });
  const lastSentBarcodesRef = useRef<string[]>([]);
  const tracksRef = useRef<Track[]>([]);
  const [researching, setResearching] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(historySearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [historySearch]);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
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
  const history = useHistory(debouncedSearch, view === "history");
  const savedFinds = useHistory("", settingsOpen);
  const historyItems = useMemo(() =>
    [...new Map(history.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? []).values()],
  [history.data]);
  const settingsItems = useMemo(() =>
    [...new Map(savedFinds.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? []).values()],
  [savedFinds.data]);
  const searchPending = historySearch.trim() !== debouncedSearch;
  const { data: routedFrameItems = NO_ITEMS } = useQuery({
    queryKey: ["frame-items", itemId],
    queryFn: () => fetchFrameItems(itemId!),
    enabled: Boolean(itemId),
  });

  const updateFindCriteria = (nextCriteria: string) => {
    findCriteriaRef.current = nextCriteria;
    setFindCriteria(nextCriteria);
    window.localStorage.setItem(FIND_CRITERIA_STORAGE_KEY, nextCriteria);
  };

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

  useEffect(() => {
    marketRef.current = market;
    window.localStorage.setItem(MARKET_STORAGE_KEY, market);
  }, [market]);

  useEffect(() => {
    window.localStorage.setItem(OFFER_TARGETS_STORAGE_KEY, JSON.stringify(offerTargets));
  }, [offerTargets]);

  useEffect(() => {
    deviceDetectionEnabledRef.current = deviceDetectionEnabled;
    window.localStorage.setItem(DEVICE_DETECTION_STORAGE_KEY, deviceDetectionEnabled ? "on" : "off");
  }, [deviceDetectionEnabled]);

  useEffect(() => {
    maxConcurrentFramesRef.current = maxConcurrentFrames;
    window.localStorage.setItem("yard-sale-max-concurrent-frames", String(maxConcurrentFrames));
  }, [maxConcurrentFrames]);

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

  const applyResearchedItems = useCallback((researched: DetectedItem[]) => {
    const byId = new Map(researched.map((item) => [item.id, item]));
    streamQueueRef.current = streamQueueRef.current.map((item) => byId.get(item.id) ?? item);
    setLiveItems((current) => current.map((item) => byId.get(item.id) ?? item));
    setSelectedItem((current) => (current && byId.get(current.id)) ?? current);
    setSelectedFrameItems((current) => current.map((item) => byId.get(item.id) ?? item));
    queryClient.setQueriesData<DetectedItem[]>(
      { queryKey: ["frame-items"] },
      (current) => current?.map((item) => byId.get(item.id) ?? item),
    );
  }, [queryClient]);

  const submitBlob = useCallback(
    async (
      activeSessionId: string,
      blob: Blob,
      deviceDetections: DeviceDetection[] = [],
      barcodes: DeviceBarcode[] = [],
      onAccepted?: () => void,
    ) => {
      if (inFlightRef.current >= maxConcurrentFramesRef.current) return;
      onAccepted?.();
      const capturedAtMs = performance.now();
      inFlightRef.current += 1;
      setInFlight(inFlightRef.current);
      // The concurrency slot is released once quick prices arrive; research continues in the background.
      let slotHeld = true;
      let researchPending = false;
      const releaseSlot = () => {
        if (!slotHeld) return;
        slotHeld = false;
        inFlightRef.current -= 1;
        setInFlight(inFlightRef.current);
      };
      try {
        const form = new FormData();
        form.set("sessionId", activeSessionId);
        form.set("capturedAt", new Date().toISOString());
        form.set("findCriteria", findCriteriaRef.current);
        form.set("market", marketRef.current);
        if (deviceDetections.length > 0) form.set("deviceDetections", JSON.stringify(deviceDetections));
        if (barcodes.length > 0) form.set("barcodes", JSON.stringify(barcodes));
        form.set("image", blob, "frame.jpg");
        const response = await fetch("/api/analyze", { method: "POST", body: form });
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Frame analysis failed");
        }

        let streamError: string | null = null;
        await readAnalysisStream(response.body, (event) => {
          if (event.type === "items" && event.phase === "identified") {
            releaseSlot();
            if (event.items.some((item) => item.pricingStatus === "researching")) {
              researchPending = true;
              setResearching((current) => current + 1);
            }
            if (event.items.length > 0) {
              // Live price labels start on the detector boxes that were sent with this frame. A late
              // answer gets no labels, because the camera has probably moved since the capture.
              const now = performance.now();
              if (deviceDetections.length > 0 && now - capturedAtMs <= TRACK_MAX_SEED_DELAY_MS) {
                tracksRef.current = mergeTracks(tracksRef.current, seedTracks(event.items, deviceDetections, now));
              }
              streamQueueRef.current.push(...event.items);
              startItemStream();
              playFoundSound();
              void refreshHistory();
            }
          } else if (event.type === "items") {
            applyResearchedItems(event.items);
            void refreshHistory();
          } else if (event.type === "done") {
            queryClient.setQueryData(["stats"], event.stats);
          } else {
            streamError = event.error;
          }
        });
        if (streamError) throw new Error(streamError);
        setError(null);
      } catch (frameError) {
        setError(frameError instanceof Error ? frameError.message : "Frame analysis failed");
      } finally {
        releaseSlot();
        if (researchPending) setResearching((current) => current - 1);
      }
    },
    [applyResearchedItems, playFoundSound, queryClient, refreshHistory, startItemStream],
  );

  const submitFrame = useCallback(
    async (activeSessionId: string, onCaptured?: () => void, { gated = false } = {}) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || inFlightRef.current >= maxConcurrentFramesRef.current) return;
      if (video.currentTime === lastVideoTimeRef.current) return;

      // Automatic captures skip frames where the on-device detector sees nothing new.
      const detections = deviceDetectionEnabledRef.current ? latestDetectionsRef.current : null;
      if (gated && detections) {
        const decision = gateFrame({
          detections,
          lastSent: lastSentDetectionsRef.current,
          msSinceLastSent: Date.now() - lastSentAtRef.current,
          maxQuietMs: MAX_QUIET_MS,
        });
        const freshBarcodes = performance.now() - latestBarcodesRef.current.at < BARCODE_TTL_MS ? latestBarcodesRef.current.codes : [];
        const newBarcode = freshBarcodes.some((code) => !lastSentBarcodesRef.current.includes(code.value));
        if (!decision.send && !newBarcode) {
          setSkippedFrames((current) => current + 1);
          return;
        }
      }
      const hints = detections ? sellableDetections(detections) : [];
      const barcodes = performance.now() - latestBarcodesRef.current.at < BARCODE_TTL_MS ? latestBarcodesRef.current.codes : [];
      const frameTime = video.currentTime;
      // The gate state changes only when the frame is really sent, not when all slots are busy.
      const markSent = () => {
        lastSentBarcodesRef.current = barcodes.map((code) => code.value);
        lastSentDetectionsRef.current = hints;
        lastSentAtRef.current = Date.now();
        lastVideoTimeRef.current = frameTime;
      };

      const scale = Math.min(1, 960 / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      onCaptured?.();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.76));
      if (!blob) return;
      await submitBlob(activeSessionId, blob, hints, barcodes, markSent);
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
    lastSentDetectionsRef.current = null;
    intervalRef.current = window.setInterval(
      () => void submitFrame(activeSessionId, playSnapshotFeedback, { gated: true }),
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
      () => void submitFrame(sessionId, playSnapshotFeedback, { gated: true }),
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
      const barcodes = deviceDetectionEnabledRef.current
        ? await loadBarcodeReader().then((reader) => readBarcodes(reader, canvas)).catch(() => [])
        : [];
      setSourceLabel(file.name);
      const id = await beginSession("image", file.name);
      await submitBlob(id, blob, [], barcodes);
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
    setMediaEnded(false);
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

  const detectorActive =
    view === "scan" && deviceDetectionEnabled && Boolean(sessionId) && source !== "image" && !mediaEnded;
  useEffect(() => {
    if (!detectorActive) {
      latestDetectionsRef.current = null;
      tracksRef.current = [];
      setLiveDetections(null);
      setDetectorStatus("off");
      return;
    }
    let cancelled = false;
    let frameRequest = 0;
    let lastRun = 0;
    let lastOverlayKey = "";
    setDetectorStatus("loading");
    loadDetector()
      .then((detector) => {
        if (cancelled) return;
        setDetectorStatus("ready");
        const tick = (now: number) => {
          if (cancelled) return;
          frameRequest = window.requestAnimationFrame(tick);
          if (now - lastRun < DETECTION_INTERVAL_MS) return;
          lastRun = now;
          const video = videoRef.current;
          if (!video || video.readyState < 2) {
            latestDetectionsRef.current = null;
            tracksRef.current = [];
            lastOverlayKey = "";
            setLiveDetections(null);
            return;
          }
          let detections: DeviceDetection[];
          try {
            detections = detectVideoFrame(detector, video, now);
          } catch {
            cancelled = true;
            latestDetectionsRef.current = null;
            setLiveDetections(null);
            setDetectorStatus("failed");
            return;
          }
          latestDetectionsRef.current = detections;
          const shown = sellableDetections(detections);
          tracksRef.current = updateTracks(tracksRef.current, shown, now);
          const tracks = tracksRef.current;
          // Only re-render when the boxes change, to leave the CPU and GPU for the detector.
          const boxKey = (box: DeviceDetection["box"]) => Object.values(box).map((value) => Math.round(value / 10)).join(",");
          const overlayKey = `${video.clientWidth}x${video.clientHeight}|${shown
            .map((detection) => `${detection.label}:${boxKey(detection.box)}`)
            .join(";")}|${tracks.map((track) => `${track.itemId}:${boxKey(track.box)}`).join(";")}`;
          if (overlayKey === lastOverlayKey) return;
          lastOverlayKey = overlayKey;
          setLiveDetections({
            detections: shown,
            tracks,
            width: video.videoWidth,
            height: video.videoHeight,
            // With "slice" (object-fit: cover) one CSS pixel is this many video pixels.
            unitsPerPixel: 1 / Math.max(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight),
          });
        };
        frameRequest = window.requestAnimationFrame(tick);
      })
      .catch(() => {
        if (!cancelled) setDetectorStatus("failed");
      });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameRequest);
    };
  }, [detectorActive]);

  useEffect(() => {
    if (!detectorActive) {
      latestBarcodesRef.current = { codes: [], at: 0 };
      return;
    }
    let cancelled = false;
    let busy = false;
    let timer = 0;
    loadBarcodeReader()
      .then((reader) => {
        if (cancelled) return;
        timer = window.setInterval(() => {
          const video = videoRef.current;
          if (busy || !video || video.readyState < 2) return;
          busy = true;
          readBarcodes(reader, video)
            .then((codes) => {
              if (codes.length > 0) latestBarcodesRef.current = { codes, at: performance.now() };
            })
            .catch(() => undefined)
            .finally(() => {
              busy = false;
            });
        }, BARCODE_INTERVAL_MS);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detectorActive]);

  const displayedItems = view === "scan" ? liveItems : historyItems;

  useEffect(() => {
    if (view !== "history") return;
    stopMedia();
    setSelectedCameraId("off");
    setSessionId(null);
    setStillPreviewUrl(null);
  }, [view]);

  const openItem = (selected: DetectedItem, sourceView: View) => {
    const sourceItems = sourceView === "scan" ? liveItems : historyItems;
    setSelectedItem(selected);
    setSelectedFrameItems(sourceItems.filter((candidate) => candidate.thumbnailUrl === selected.thumbnailUrl));
    void navigate({
      to: "/finds/$itemId",
      params: { itemId: selected.id },
      search: { from: sourceView },
      resetScroll: false,
    });
  };

  const deleteFind = async (item: DetectedItem) => {
    setDeletingItemId(item.id);
    try {
      await deleteFindRequest(item.id);
      setLiveItems((current) => current.filter((candidate) => candidate.id !== item.id));
      await refreshHistory();
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this find.");
    } finally {
      setDeletingItemId(null);
    }
  };

  const deleteAllFinds = async () => {
    setDeletingItemId("all");
    try {
      await deleteAllFindsRequest();
      setLiveItems([]);
      await queryClient.resetQueries({ queryKey: ["items"] });
      setSettingsOpen(false);
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete all finds.");
    } finally {
      setDeletingItemId(null);
    }
  };

  return (
    <OfferTargetsContext.Provider value={offerTargets}>
    <div className={`app-shell ${view === "scan" ? "scan-shell" : "history-shell"}`}>
      {view === "scan" ? (
        <main className="immersive-scan">
          <section className="camera-stage">
            <video ref={videoRef} playsInline onEnded={() => { stopScan(); setMediaEnded(true); }} />
            {liveDetections && liveDetections.width > 0 && (
              <svg
                className="detection-overlay"
                viewBox={`0 0 ${liveDetections.width} ${liveDetections.height}`}
                preserveAspectRatio="xMidYMid slice"
              >
                {liveDetections.detections.map((detection, index) => {
                  const x = (detection.box.xMin / 1000) * liveDetections.width;
                  const y = (detection.box.yMin / 1000) * liveDetections.height;
                  return (
                    <g key={`${detection.label}-${index}`} aria-hidden="true">
                      <rect
                        x={x}
                        y={y}
                        width={((detection.box.xMax - detection.box.xMin) / 1000) * liveDetections.width}
                        height={((detection.box.yMax - detection.box.yMin) / 1000) * liveDetections.height}
                        rx={6 * liveDetections.unitsPerPixel}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        className="detector-label"
                        x={x + 6 * liveDetections.unitsPerPixel}
                        y={y + 18 * liveDetections.unitsPerPixel}
                        fontSize={14 * liveDetections.unitsPerPixel}
                        strokeWidth={3 * liveDetections.unitsPerPixel}
                      >
                        {detection.label}
                      </text>
                    </g>
                  );
                })}
                {liveDetections.tracks.map((track) => {
                  const item = liveItems.find((candidate) => candidate.id === track.itemId);
                  if (!item) return null;
                  const unit = liveDetections.unitsPerPixel;
                  const text = `${item.name.length > 24 ? `${item.name.slice(0, 23)}…` : item.name} · ${formatRange(item)}`;
                  // Approximate text width; the label is kept inside the right edge of the frame.
                  const labelWidth = Math.min((text.length * 7.4 + 16) * unit, liveDetections.width);
                  const x = Math.min((track.box.xMin / 1000) * liveDetections.width, liveDetections.width - labelWidth);
                  const y = Math.max(0, (track.box.yMin / 1000) * liveDetections.height - 30 * unit);
                  return (
                    <g
                      key={`track-${track.itemId}`}
                      className={`price-label ${item.pricingStatus}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${item.name}, ${formatRange(item)}. Open details.`}
                      onClick={() => openItem(item, "scan")}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        openItem(item, "scan");
                      }}
                    >
                      <rect x={x} y={y} width={labelWidth} height={26 * unit} rx={13 * unit} />
                      <text x={x + 8 * unit} y={y + 18 * unit} fontSize={13 * unit}>{text}</text>
                    </g>
                  );
                })}
              </svg>
            )}
            {stillPreviewUrl && <img className="still-preview" src={stillPreviewUrl} alt="Uploaded frame" />}
            {!sessionId && (
              <div className="camera-empty">
                <div className="reticle"><ScanLine size={44} /></div>
              </div>
            )}
            <div className="camera-shade" aria-hidden="true" />
            {snapshotFlash > 0 && <span key={snapshotFlash} className="snapshot-flash" aria-hidden="true" />}

            <header className="scan-topbar">
              <label className="camera-select-control">
                <Camera size={14} />
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
              <div className={`live-state ${scanning ? "is-live" : ""}`} aria-live="polite">
                <span />
                {scanning ? "Live" : "Paused"}
              </div>
              <button className="settings-trigger" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
                <Settings size={15} />
              </button>
            </header>

            <section className="stats-ribbon" aria-label="Live processing statistics">
              <div className="stat active-stat" title={`${inFlight} of ${maxConcurrentFrames} requests active`}>
                {inFlight > 0 ? <LoaderCircle className="spin" size={12} /> : <Gauge size={12} />}
                <strong>{inFlight}/{maxConcurrentFrames}</strong>
                <span>Active</span>
              </div>
              {researching > 0 && (
                <div className="stat research-stat" title="Frames with items still being researched">
                  <Search size={12} />
                  <strong>{researching}</strong>
                  <span>Researching</span>
                </div>
              )}
              {detectorStatus === "ready" && skippedFrames > 0 && (
                <div className="stat" title="Frames skipped by on-device detection because nothing new was in view">
                  <strong>{skippedFrames.toLocaleString()}</strong>
                  <span>Skipped</span>
                </div>
              )}
              <Stat label="Frames" value={stats.framesProcessed} />
              <Stat label="Items" value={stats.itemsIdentified} />
              <Stat label="Searches" value={stats.searchesPerformed} />
              <Stat label="Calls" value={stats.modelCalls} />
            </section>

            {sessionId && <div className="source-caption">
              {source === "camera" ? <Camera size={13} /> : source === "image" ? <ImageUp size={13} /> : <Video size={13} />}
              <span>{sourceLabel}</span>
            </div>}

            <section className="live-find-stack" aria-label="Latest finds">
              {liveItems.map((item) => (
                <ItemCard
                  key={`${item.id}-${streamItemTokens[item.id] ?? "stable"}`}
                  item={item}
                  animate
                  overlay
                  onSelect={(selected) => openItem(selected, "scan")}
                />
              ))}
            </section>

            {error && (
              <div className="error-banner">
                <span>{error}</span>
                <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
              </div>
            )}
            <canvas ref={canvasRef} hidden />
          </section>
        </main>
      ) : (
        <main className="history-screen">
          <header className="history-heading">
            <div>
              <p className="eyebrow">All-time finds</p>
              <h1>History</h1>
            </div>
            <div className="history-actions">
              <button className="icon-button" onClick={() => void refreshHistory()} aria-label="Refresh history">
                <History size={20} />
              </button>
              <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
                <Settings size={19} />
              </button>
            </div>
          </header>
          <section className="stats-ribbon history-stats" aria-label="Processing statistics">
            <Stat label="Frames" value={stats.framesProcessed} />
            <Stat label="Items" value={stats.itemsIdentified} />
            <Stat label="Searches" value={stats.searchesPerformed} />
            <Stat label="Calls" value={stats.modelCalls} />
          </section>
          <div className="history-search">
            <Search size={18} aria-hidden="true" />
            <input type="search" aria-label="Search all history" placeholder="Search all finds, brands, descriptions…"
              maxLength={500} value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} />
            {historySearch && <button onClick={() => setHistorySearch("")} aria-label="Clear history search"><X size={18} /></button>}
          </div>
          {error && (
            <div className="error-banner history-error">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
            </div>
          )}
          <section className="finds-section" aria-busy={history.isFetching || searchPending}>
            <HistoryLoading query={history} searchPending={searchPending} />
            <div className="item-feed">
              {displayedItems.map((item) => (
                <ItemCard key={`${item.id}-history`} item={item} showCapturedAt onSelect={(selected) => openItem(selected, "history")} />
              ))}
              {displayedItems.length === 0 && !history.isPending && !history.isError && !searchPending && (
                <div className="empty-feed">
                  <CircleDollarSign size={36} />
                  <p>{debouncedSearch ? "No finds match your search." : "No saved finds yet."}</p>
                </div>
              )}
            </div>
            <HistoryLoadMore query={history} disabled={searchPending} />
          </section>
        </main>
      )}

      <nav className={`bottom-nav ${view === "scan" ? "scan-nav" : ""}`} aria-label="Primary navigation">
        <Link to="/scan" className={view === "scan" ? "active" : ""}>
          <ScanLine /> <span>Scan</span>
        </Link>
        {view === "scan" && <>
          <button
            className={`dock-action ${scanning ? "is-active" : ""}`}
            onClick={() => void toggleLiveScan()}
            aria-label={scanning ? "Stop live scanning" : "Start live scanning"}
          >
            {scanning ? <Square size={18} fill="currentColor" /> : <ScanLine size={20} />}
            <span>{scanning ? "Stop" : "Live"}</span>
          </button>
          <button className="dock-action snapshot-action" onClick={() => void takeSnapshot()} aria-label="Take snapshot">
            <Camera size={22} />
            <span>Snap</span>
          </button>
          <label className="dock-action dock-upload" aria-label="Upload a photo or video">
            <ImageUp size={20} />
            <span>Upload</span>
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
        </>}
        <Link to="/history" className={view === "history" ? "active" : ""} onClick={() => void refreshHistory()}>
          <Archive /> <span>History</span>
        </Link>
      </nav>

      {settingsOpen && (
        <div className="settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">Saved inventory</p>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button>
            </header>
            <div className="settings-find-list">
              <div className="settings-text-field">
                <label htmlFor="find-criteria">Find criteria</label>
                <textarea
                  id="find-criteria"
                  rows={3}
                  maxLength={1000}
                  value={findCriteria}
                  placeholder="Vintage band tees worth more than $40"
                  onChange={(event) => updateFindCriteria(event.target.value)}
                />
                <div className="criteria-presets" aria-label="Quick find criteria">
                  {FIND_CRITERIA_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={findCriteria === preset.value ? "active" : ""}
                      onClick={() => updateFindCriteria(preset.value)}
                    >
                      {preset.label}
                    </button>
                  ))}
                  {findCriteria && <button type="button" onClick={() => updateFindCriteria("")}>Clear</button>}
                </div>
              </div>
              <div className="settings-range">
                <label htmlFor="market">
                  <span>Market and currency</span>
                </label>
                <select id="market" className="settings-select" value={market} onChange={(event) => setMarket(event.target.value as Market)}>
                  {(Object.keys(MARKETS) as Market[]).map((key) => (
                    <option key={key} value={key}>{MARKETS[key].label}</option>
                  ))}
                </select>
                <small className="settings-hint">New finds are priced in this currency with {MARKETS[market].carrier} shipping and local platform fees. Saved finds keep their currency.</small>
              </div>
              <div className="settings-range">
                <label htmlFor="min-profit">
                  <span>Minimum profit to buy</span>
                  <strong>{money(offerTargets.minProfitCents, MARKETS[market].currency)}</strong>
                </label>
                <input
                  id="min-profit"
                  type="range"
                  min="0"
                  max="10000"
                  step="100"
                  value={offerTargets.minProfitCents}
                  onChange={(event) => setOfferTargets((current) => ({ ...current, minProfitCents: Number(event.target.value) }))}
                />
                <div><span>{money(0, MARKETS[market].currency)}</span><span>{money(10_000, MARKETS[market].currency)}</span></div>
              </div>
              <div className="settings-range">
                <label htmlFor="min-roi">
                  <span>Minimum ROI to buy</span>
                  <strong>{Math.round(offerTargets.minRoi * 100)}%</strong>
                </label>
                <input
                  id="min-roi"
                  type="range"
                  min="0"
                  max="5"
                  step="0.25"
                  value={offerTargets.minRoi}
                  onChange={(event) => setOfferTargets((current) => ({ ...current, minRoi: Number(event.target.value) }))}
                />
                <div><span>0%</span><span>500%</span></div>
              </div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={deviceDetectionEnabled}
                  onChange={(event) => setDeviceDetectionEnabled(event.target.checked)}
                />
                <span>
                  <strong>On-device detection</strong>
                  <small>
                    Finds objects and barcodes in the browser, shows live price labels, and skips live frames with nothing new in view.
                    {detectorStatus === "loading" && " Loading model…"}
                    {detectorStatus === "failed" && " The model could not load, so every frame is sent."}
                  </small>
                </span>
              </label>
              <div className="settings-range">
                <label htmlFor="concurrent-processing">
                  <span>Concurrent processing</span>
                  <strong>{maxConcurrentFrames}</strong>
                </label>
                <input
                  id="concurrent-processing"
                  type="range"
                  min="1"
                  max={MAX_CONCURRENT_FRAMES_SETTING}
                  step="1"
                  value={maxConcurrentFrames}
                  onChange={(event) => setMaxConcurrentFrames(Number(event.target.value))}
                />
                <div><span>1</span><span>{MAX_CONCURRENT_FRAMES_SETTING}</span></div>
              </div>
              <div className="settings-range">
                <label htmlFor="scan-frequency">
                  <span>Live scan frequency</span>
                  <strong>{scanIntervalSeconds}s</strong>
                </label>
                <input
                  id="scan-frequency"
                  type="range"
                  min="1"
                  max="30"
                  step="1"
                  value={scanIntervalSeconds}
                  onChange={(event) => changeScanInterval(Number(event.target.value))}
                />
                <div><span>1s</span><span>30s</span></div>
              </div>
              <HistoryLoading query={savedFinds} />
              {settingsItems.map((item) => (
                <div className="settings-find" key={item.id}>
                  <img src={item.thumbnailUrl} alt="" />
                  <div>
                    <strong>{item.name}</strong>
                    <span>{formatRange(item)}</span>
                  </div>
                  <button
                    onClick={() => void deleteFind(item)}
                    disabled={deletingItemId !== null}
                    aria-label={`Delete ${item.name}`}
                  >
                    {deletingItemId === item.id ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
                  </button>
                </div>
              ))}
              {settingsItems.length === 0 && !savedFinds.isPending && !savedFinds.isError && <p className="settings-empty">No saved finds.</p>}
              <HistoryLoadMore query={savedFinds} />
            </div>
            <footer>
              <button
                className="delete-all-button"
                onClick={() => void deleteAllFinds()}
                disabled={settingsItems.length === 0 || deletingItemId !== null}
              >
                {deletingItemId === "all" ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
                Delete all finds
              </button>
              <span>Processing stats are kept.</span>
            </footer>
          </section>
        </div>
      )}

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
                    resetScroll: false,
                  }
                : {
                    to: "/finds/$itemId",
                    params: { itemId: nextItem.id },
                    search: { from: view },
                    replace: true,
                    resetScroll: false,
                  },
            );
          }}
          activityOpen={activityOpen}
          onToggleActivity={() => {
            void navigate(
              activityOpen
                ? { to: "/finds/$itemId", params: { itemId: selectedItem.id }, search: { from: view }, resetScroll: false }
                : { to: "/finds/$itemId/activity", params: { itemId: selectedItem.id }, search: { from: view }, resetScroll: false },
            );
          }}
          onClose={() => {
            void navigate({ to: view === "scan" ? "/scan" : "/history", resetScroll: false });
          }}
        />
      )}
      {children}
    </div>
    </OfferTargetsContext.Provider>
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

function HistoryLoading({ query, searchPending = false }: { query: ReturnType<typeof useHistory>; searchPending?: boolean }) {
  if (query.isError) return (
    <div className="history-status" role="alert">
      <span>{query.error.message}</span>
      <button className="history-load-more" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} disabled={query.isFetching}>Retry</button>
    </div>
  );
  if (query.isFetching || searchPending) return <p className="history-status" role="status">{searchPending ? "Searching…" : "Loading finds…"}</p>;
  return null;
}

function HistoryLoadMore({ query, disabled = false }: { query: ReturnType<typeof useHistory>; disabled?: boolean }) {
  if (!query.hasNextPage) return null;
  return <button className="history-load-more" disabled={disabled || query.isFetching} onClick={() => void query.fetchNextPage()}>
    {query.isFetchingNextPage ? "Loading…" : "Load more finds"}
  </button>;
}

function CapturedTime({ timestamp }: { timestamp?: string | null }) {
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;
  const date = new Date(timestamp);
  return <time className="captured-time" dateTime={date.toISOString()}>
    Snapped {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
  </time>;
}

function ItemCard({
  item,
  animate,
  overlay,
  showCapturedAt,
  onSelect,
}: {
  item: DetectedItem;
  animate?: boolean;
  overlay?: boolean;
  showCapturedAt?: boolean;
  onSelect: (item: DetectedItem) => void;
}) {
  return (
    <button
      className={`item-card${animate ? " stream-in" : ""}${overlay ? " overlay-card" : ""}`}
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
          {!showCapturedAt && <RelativeTime timestamp={item.firstSeenAt} />}
        </div>
        {showCapturedAt && <CapturedTime timestamp={item.lastSeenAt} />}
        <h3>{item.name}</h3>
        <p>{item.valueSummary}</p>
        <div className="price-comparison card-prices">
          <div className="price-box resale-price">
            <span>Resale</span>
            <strong>{formatRange(item)}</strong>
          </div>
          <div className="price-box retail-price">
            <span>Retail</span>
            <strong>{item.retailPriceCents === null ? "—" : money(item.retailPriceCents, item.currency)}</strong>
          </div>
        </div>
        <div className="card-badges">
          <PricingBadge item={item} />
          <OfferBadge item={item} />
          <OnlineBadge item={item} />
          {item.observedPriceCents !== null && <span className="tag-price">Tag {money(item.observedPriceCents, item.currency)}</span>}
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
  const modalRef = useRef<HTMLElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadImage = async () => {
    if (!modalRef.current || downloading) return;
    const modal = modalRef.current;
    setDownloading(true);
    setDownloadError(null);
    try {
      const { downloadModalImage } = await import("./download-modal");
      await downloadModalImage(modal, `${item.name}${activityOpen ? "-activity" : ""}`);
    } catch {
      setDownloadError("Could not download the image. Check your connection and try again.");
    } finally {
      setDownloading(false);
    }
  };
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
      <article ref={modalRef} className="detail-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <button className="download-image-button" data-export-exclude onClick={() => void downloadImage()} disabled={downloading} aria-label={downloading ? "Downloading image" : "Download modal as image"}>
          {downloading ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
          {downloading ? "Preparing…" : "Download image"}
        </button>
        <button className="close-button" data-export-exclude onClick={onClose} aria-label="Close"><X /></button>
        <div className="detail-scroll">
          <div className="detail-visual">
            <AnnotatedImage
              key={item.thumbnailUrl}
              items={frameItems}
              activeItemId={highlightedItemId}
              onHoverItem={setHoveredItemId}
            />
          </div>
          <div className="detail-content">
          {downloadError && <p className="download-image-error" data-export-exclude role="alert">{downloadError}</p>}
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
          <button className="agent-activity-toggle" data-export-exclude onClick={onToggleActivity}>
            <Bot size={17} /> {activityOpen ? "Back to find" : "Agent activity"}
          </button>
          {activityOpen ? (
            <AgentActivity itemId={item.id} />
          ) : (
            <>
              <p className="eyebrow">{item.category} · {Math.round(item.confidence * 100)}% confidence</p>
              <h2>{item.name}</h2>
              <p className="detail-description">{item.description}</p>
              <div className="detail-values">
                <div className="price-comparison">
                  <div className="price-box resale-price">
                    <span>Estimated resale</span>
                    <strong>{formatRange(item)}</strong>
                  </div>
                  <div className="price-box retail-price">
                    <span>Estimated retail</span>
                    <strong>{item.retailPriceCents === null ? "—" : money(item.retailPriceCents, item.currency)}</strong>
                  </div>
                </div>
                <PricingPathPanel item={item} />
                <p>{item.valueSummary}</p>
              </div>
              <OfferPanel item={item} />
              <PriceBreakdown item={item} />
              <SaleOptionsPanel item={item} />
              <a
                className="lens-search-link"
                data-export-exclude
                href={`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(new URL(item.thumbnailUrl, window.location.origin).href)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Search size={17} /> Search full frame with Google Lens <ExternalLink size={15} />
              </a>
              {marketEvidence.length > 0 && (
                <section className="comparables">
                  <h3>Comps</h3>
                  <CompStatsSummary item={item} />
                  {marketEvidence.map((comparable, index) => {
                    // Unscored comps (saved before match scoring) are shown but not used, like poor matches.
                    const poorMatch = comparable.type !== "web" && (comparable.matchScore ?? 0) < MIN_MATCH_SCORE;
                    const details = [
                      comparable.source,
                      comparable.condition,
                      comparable.soldAt ? `sold ${new Date(comparable.soldAt).toLocaleDateString()}` : null,
                      comparable.matchScore != null ? `${Math.round(comparable.matchScore * 100)}% match` : comparable.type === "web" ? null : "not scored",
                      comparable.originalCurrency && comparable.originalPriceCents != null
                        ? `from ${money(comparable.originalPriceCents, comparable.originalCurrency)}`
                        : null,
                    ].filter(Boolean);
                    const content = (
                      <>
                        <span className={`comp-type ${comparable.type}`}>{comparable.type}</span>
                        <span className="comp-title">
                          {comparable.title}
                          {details.length > 0 && <small>{details.join(" · ")}</small>}
                        </span>
                        <strong>{comparable.priceCents === null ? "—" : money(comparable.priceCents, comparable.currency)}</strong>
                        {comparable.url && <ExternalLink size={15} />}
                      </>
                    );
                    const className = poorMatch ? "poor-match" : undefined;
                    return comparable.url ? (
                      <a key={`${comparable.title}-${index}`} className={className} href={comparable.url} target="_blank" rel="noreferrer">{content}</a>
                    ) : (
                      <div key={`${comparable.title}-${index}`} className={className}>{content}</div>
                    );
                  })}
                </section>
              )}
              <dl className="facts">
                <div><dt>Brand</dt><dd>{item.brand ?? "Unknown"}</dd></div>
                <div><dt>Model</dt><dd>{item.model ?? "Unknown"}</dd></div>
                <div><dt>Condition</dt><dd>{item.condition}</dd></div>
                <div><dt>Category</dt><dd>{item.category}</dd></div>
                {item.barcode && <div><dt>Barcode</dt><dd>{item.barcode}</dd></div>}
                {item.vintage && <div><dt>Age</dt><dd>Vintage (20+ years)</dd></div>}
                <div><dt>Seen</dt><dd>{item.seenCount} time{item.seenCount === 1 ? "" : "s"}</dd></div>
                <div><dt>First seen</dt><dd>{new Date(item.firstSeenAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
              </dl>
            </>
          )}
          </div>
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

function PricingBadge({ item }: { item: DetectedItem }) {
  if (item.pricingStatus === "researching") {
    return <span className="pricing-badge researching"><LoaderCircle className="spin" size={10} /> Researching</span>;
  }
  if (item.pricingStatus === "research_failed") return <span className="pricing-badge failed">Quick estimate</span>;
  if (item.pricingPath === "instant") return <span className="pricing-badge instant"><Zap size={10} /> Instant</span>;
  return <span className="pricing-badge researched"><Search size={10} /> Researched</span>;
}

function OnlineBadge({ item }: { item: DetectedItem }) {
  const outlook = saleOutlook(item);
  if (outlook.verdict !== "online" || outlook.premiumCents === null || !outlook.bestOnline) return null;
  return (
    <span className="online-badge">
      <Globe size={10} /> +{money(outlook.premiumCents, item.currency)} on {outlook.bestOnline.platform.name}
    </span>
  );
}

function useOfferAdvice(item: DetectedItem) {
  const targets = useContext(OfferTargetsContext);
  const best = saleOutlook(item).best;
  if (!best || best.netCents === null) return null;
  return { advice: offerAdvice(item.observedPriceCents, best.netCents, targets), best };
}

function OfferBadge({ item }: { item: DetectedItem }) {
  const result = useOfferAdvice(item);
  if (!result || item.pricingStatus === "researching") return null;
  const { advice } = result;
  const label =
    advice.verdict === "offer" ? `Max ${money(advice.maxOfferCents, item.currency)}` : advice.verdict[0]!.toUpperCase() + advice.verdict.slice(1);
  return <span className={`offer-badge ${advice.verdict}`}>{label}</span>;
}

function OfferPanel({ item }: { item: DetectedItem }) {
  const targets = useContext(OfferTargetsContext);
  const result = useOfferAdvice(item);
  if (!result) return null;
  const { advice, best } = result;
  const maxOffer = money(advice.maxOfferCents, item.currency);
  const headline = {
    buy: "Buy",
    negotiate: `Negotiate: offer ${maxOffer} or less`,
    pass: "Pass",
    offer: advice.maxOfferCents > 0 ? `Pay up to ${maxOffer}` : "Not worth reselling",
  }[advice.verdict];
  const targetText = `your targets of ${money(targets.minProfitCents, item.currency)} profit and ${Math.round(targets.minRoi * 100)}% ROI`;

  return (
    <section className={`offer-panel ${advice.verdict}`}>
      <strong>{headline}</strong>
      <span>
        {advice.maxOfferCents > 0
          ? `The most to pay is ${maxOffer}, to meet ${targetText}.`
          : `It cannot meet ${targetText}.`}{" "}
        Expected net: {money(advice.expectedNetCents, item.currency)} ({best.platform.name}).
        {item.pricingStatus === "researching" && " Research is still running, so this can change."}
      </span>
    </section>
  );
}

function CompStatsSummary({ item }: { item: DetectedItem }) {
  const stats = compStats(item.comparables, item.currency);
  const row = (label: string, value: PriceStats | null) =>
    value && (
      <div>
        <dt>{label}</dt>
        <dd>
          <strong>{money(value.medianCents, item.currency)}</strong> median · {value.count} comp{value.count === 1 ? "" : "s"}
          {value.count > 1 && ` · ${money(value.lowCents, item.currency)}–${money(value.highCents, item.currency)}`}
          {value.excluded > 0 && ` · ${value.excluded} left out`}
        </dd>
      </div>
    );
  if (stats.confidence === "none") return null;
  return (
    <dl className={`comp-stats ${stats.confidence}`}>
      {row("Sold", stats.sold)}
      {row("Listed", stats.active)}
      {row("Retail", stats.retail)}
      <div>
        <dt>Evidence</dt>
        <dd>
          {{ high: "Strong: 5 or more sold comps", medium: "Fair: a few sold comps or many listings", low: "Weak: very few comps" }[stats.confidence]}
        </dd>
      </div>
    </dl>
  );
}

function PricingPathPanel({ item }: { item: DetectedItem }) {
  const decidedBy = {
    jev: "Jev",
    luna: "Luna",
    reused: "An earlier scan",
    config: "The research-all setting",
  }[item.triageSource];
  const certainty = item.triageConfidence === null ? "" : ` (${Math.round(item.triageConfidence * 100)}% sure)`;
  let title: string;
  let detail: string;
  if (item.pricingStatus === "researching") {
    title = "Quick estimate · researching now";
    detail = `${decidedBy} flagged this item for web and marketplace research${certainty}. Prices update when research finishes.`;
  } else if (item.pricingStatus === "research_failed") {
    title = "Quick estimate · research did not finish";
    detail = "These prices come from Luna's general knowledge only. Check the comps before you buy.";
  } else if (item.triageSource === "reused") {
    title = "Researched earlier";
    detail = "This item was researched on an earlier scan, so its prices were reused without new searches.";
  } else if (item.pricingPath === "instant") {
    title = "Priced instantly";
    detail = `${decidedBy} decided this item does not need research${certainty}. The price comes from general knowledge.`;
  } else {
    title = "Researched price";
    detail = `${decidedBy} sent this item to research${certainty}. Prices use retailer, eBay, and sold evidence.`;
  }

  return (
    <div className={`pricing-path ${item.pricingStatus}`}>
      <PricingBadge item={item} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
        {item.researchReason && <em>{item.researchReason}</em>}
      </div>
    </div>
  );
}

function PriceBreakdown({ item }: { item: DetectedItem }) {
  // Profit uses the best way to sell, the same net as the buy / pass verdict.
  const bestNet = saleOutlook(item).best?.netCents ?? null;
  const margin =
    item.observedPriceCents === null || bestNet === null
      ? null
      : {
          profitCents: bestNet - item.observedPriceCents,
          roi: item.observedPriceCents > 0 ? (bestNet - item.observedPriceCents) / item.observedPriceCents : null,
        };
  const rows: Array<{ label: string; value: string; tone?: "good" | "bad" }> = [];
  if (item.observedPriceCents !== null) rows.push({ label: "Tag price", value: money(item.observedPriceCents, item.currency) });
  if (margin) {
    rows.push({
      label: "Profit at tag",
      value: `${margin.profitCents < 0 ? "−" : ""}${money(Math.abs(margin.profitCents), item.currency)}${
        margin.roi === null ? "" : ` · ${Math.round(margin.roi * 100)}% ROI`
      }`,
      tone: margin.profitCents > 0 ? "good" : "bad",
    });
  }
  if (item.retailPriceCents !== null) {
    const local = localResaleCents(item);
    if (local !== null && item.retailPriceCents > 0) {
      rows.push({ label: "Resale vs retail", value: `${Math.round((local / item.retailPriceCents) * 100)}% of new` });
    }
  }
  if (rows.length === 0) return null;

  return (
    <dl className="price-breakdown">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.tone}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SaleOptionsPanel({ item }: { item: DetectedItem }) {
  const outlook = saleOutlook(item);
  const researching = item.pricingStatus === "researching" ? " Research is still running." : "";
  if (outlook.options.length === 0) {
    return (
      <section className="online-outlook unknown">
        <h3><Globe size={16} /> Where to sell</h3>
        <p>Not enough price evidence to compare.{researching}</p>
      </section>
    );
  }

  const premium = outlook.premiumCents;
  const headline =
    outlook.verdict === "online" && outlook.bestOnline && premium !== null
      ? `Sells for about ${money(premium, item.currency)} more on ${outlook.bestOnline.platform.name}`
      : outlook.verdict === "local"
        ? "Sell locally. Online nets less after fees and shipping."
        : outlook.verdict === "similar" && premium !== null
          ? `About the same online (${premium >= 0 ? "+" : "−"}${money(Math.abs(premium), item.currency)})`
          : `Online comparison needs a shipping estimate.${researching}`;

  return (
    <section className={`online-outlook ${outlook.verdict ?? "unknown"}`}>
      <h3>{outlook.verdict === "local" ? <Store size={16} /> : <Globe size={16} />} {headline}</h3>
      <table className="platform-table">
        <thead>
          <tr><th>Platform</th><th>Sale</th><th>Fees</th><th>Ship</th><th>Net</th></tr>
        </thead>
        <tbody>
          {outlook.options.map((option) => (
            <tr key={option.platform.id} className={option === outlook.best ? "best" : undefined} title={option.platform.feeSummary}>
              <td>{option.platform.name}</td>
              <td>{money(option.saleCents, item.currency)}</td>
              <td>{option.feesCents === 0 ? "—" : `−${money(option.feesCents, item.currency)}`}</td>
              <td>{option.shippingCents === null ? "?" : option.shippingCents === 0 ? "—" : `−${money(option.shippingCents, item.currency)}`}</td>
              <td>{option.netCents === null ? "?" : money(option.netCents, item.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Fees are the most common category rates. Shipping is an estimate for a seller-paid domestic label.</p>
    </section>
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
  const evidence: Array<Omit<Comparable, "type"> & { type: Comparable["type"] | "web" }> =
    item.comparables.map((comparable) => ({ ...comparable }));
  const knownUrls = new Set(evidence.map((entry) => entry.url).filter(Boolean));
  const markdownLink = /\[([^\]]+)]\((https?:\/\/[^)]+)\)/g;
  for (const match of item.valueSummary.matchAll(markdownLink)) {
    const [, title, url] = match;
    if (!url || knownUrls.has(url)) continue;
    evidence.push({ title: title || "Web result", url, priceCents: null, currency: item.currency, type: "web", source: "web" });
    knownUrls.add(url);
  }
  return evidence;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    // "$" alone is ambiguous between US and Canadian dollars, so only USD uses the narrow symbol.
    currencyDisplay: (currency || "USD") === "USD" ? "narrowSymbol" : "symbol",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
