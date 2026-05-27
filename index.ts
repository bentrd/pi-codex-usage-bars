import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WIDGET_KEY = "codex-usage-bars";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_INTERVAL_MS = 0;
const DEFAULT_BAR_WIDTH = 16;
const FILLED = "█";
const EMPTY = "░";
const RIGHT_PAD = "⠀";
const MAX_ERROR_BODY_CHARS = 600;

type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;
type UsageSource = "pi-auth" | "codex-app-server";

type UsageReport = {
  snapshots: RateLimitSnapshot[];
};

type RateLimitSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
};

type RateLimitWindow = {
  usedPercent: number;
  resetsAt?: number;
};

type QueryUsageResult =
  | { ok: true; report: UsageReport }
  | { ok: false; errors: UsageQueryError[] };

type UsageQueryError = {
  source: UsageSource;
  message: string;
  cause?: unknown;
};

type CachedReport = {
  createdAt: number;
  report: UsageReport;
};

type RateLimitStatusPayload = {
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
};

type BackendRateLimitDetails = {
  primary_window?: unknown;
  secondary_window?: unknown;
};

type BackendWindowSnapshot = {
  used_percent?: unknown;
  reset_at?: unknown;
};

type BackendAdditionalRateLimit = {
  limit_name?: unknown;
  metered_feature?: unknown;
  rate_limit?: unknown;
};

type AppServerRateLimitResponse = {
  rateLimits?: unknown;
  rateLimitsByLimitId?: unknown;
};

type AppServerRateLimitSnapshot = {
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
};

type AppServerWindowSnapshot = {
  usedPercent?: unknown;
  resetsAt?: unknown;
};

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Rgb = [number, number, number];
type Alignment = "left" | "center" | "right";
type Layout = "row" | "column";
type BarSelection = "both" | "primary" | "secondary";

type ExtensionConfig = {
  align: Alignment;
  layout: Layout;
  barWidth: number;
  refreshIntervalMs: number;
  bars: BarSelection;
  palette: "random" | "fixed";
  title: string;
  titleColor: "random" | "fixed";
  colors?: Partial<Record<keyof SessionPalette, Rgb>>;
};

type SessionPalette = {
  title: Rgb;
  primaryStart: Rgb;
  primaryEnd: Rgb;
  secondaryStart: Rgb;
  secondaryEnd: Rgb;
  empty: Rgb;
};

const PALETTES: SessionPalette[] = [
  {
    title: [255, 212, 121],
    primaryStart: [99, 179, 237],
    primaryEnd: [129, 230, 217],
    secondaryStart: [183, 148, 244],
    secondaryEnd: [246, 135, 179],
    empty: [72, 80, 96],
  },
  {
    title: [167, 243, 208],
    primaryStart: [52, 211, 153],
    primaryEnd: [163, 230, 53],
    secondaryStart: [96, 165, 250],
    secondaryEnd: [34, 211, 238],
    empty: [64, 72, 88],
  },
  {
    title: [253, 186, 116],
    primaryStart: [251, 146, 60],
    primaryEnd: [248, 113, 113],
    secondaryStart: [192, 132, 252],
    secondaryEnd: [244, 114, 182],
    empty: [73, 66, 82],
  },
  {
    title: [147, 197, 253],
    primaryStart: [56, 189, 248],
    primaryEnd: [129, 140, 248],
    secondaryStart: [45, 212, 191],
    secondaryEnd: [250, 204, 21],
    empty: [62, 70, 84],
  },
];

export default function codexUsageBars(pi: ExtensionAPI) {
  let cache: CachedReport | undefined;
  let refreshTimer: TimeoutHandle | undefined;
  let requestId = 0;
  let config = loadConfig();
  let palette = selectPalette(config);

  const clearTimer = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const clearWidget = (ctx: ExtensionContext) => {
    requestId += 1;
    clearTimer();
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const scheduleRefresh = (ctx: ExtensionContext) => {
    clearTimer();
      if (config.refreshIntervalMs <= 0) return;
    refreshTimer = setTimeout(() => {
      void refresh(ctx, true);
    }, config.refreshIntervalMs) as TimeoutHandle;
    refreshTimer.unref?.();
  };

  const setWidget = (ctx: ExtensionContext, report: UsageReport) => {
    setDisplay(ctx, formatDisplay(report, palette, config), config);
    scheduleRefresh(ctx);
  };

  const refresh = async (
    ctx: ExtensionContext,
    force: boolean,
    model = ctx.model,
  ) => {
    if (!isOpenAICodexModel(model)) {
      clearWidget(ctx);
      return;
    }

    const currentRequestId = requestId + 1;
    requestId = currentRequestId;

    const freshCache =
      cache && Date.now() - cache.createdAt < config.refreshIntervalMs
        ? cache
        : undefined;
    if (freshCache && !force) {
      setWidget(ctx, freshCache.report);
      return;
    }

    if (!cache) {
      setDisplay(ctx, [dim("codex fetching…")], config);
    }

    const result = await queryUsage(ctx, DEFAULT_TIMEOUT_MS);
    if (currentRequestId !== requestId) return;

    if (!isOpenAICodexModel(ctx.model)) {
      clearWidget(ctx);
      return;
    }

    if (!result.ok) {
      if (!cache) {
        setDisplay(
          ctx,
          [color([248, 113, 113], `codex ${statusErrorText(result.errors)}`)],
          config,
        );
      }
      scheduleRefresh(ctx);
      return;
    }

    cache = { createdAt: Date.now(), report: result.report };
    setWidget(ctx, result.report);
  };

  pi.registerCommand("codex-usage-bars-refresh", {
    description: "Reload config, reroll colors if random, and refresh Codex usage bars",
    handler: async (_args, ctx) => {
      config = loadConfig();
      palette = selectPalette(config);
      cache = undefined;
      await refresh(ctx, true);
    },
  });

  pi.registerCommand("codex-usage-bars-config", {
    description: "View or edit the Codex usage bars config",
    handler: async (_args, ctx) => {
      config = loadConfig();
      const action = await ctx.ui.select("Codex usage bars config", [
        "Show active config",
        "Interactive config designer",
        "Edit raw JSON config file",
      ]);

      if (action === "Interactive config designer") {
        const saved = await designConfig(ctx, config);
        if (saved) {
          config = loadConfig();
          palette = selectPalette(config);
          cache = undefined;
          await refresh(ctx, true);
        }
        return;
      }

      if (action === "Edit raw JSON config file") {
        const saved = await editConfigFile(ctx, config);
        if (saved) {
          config = loadConfig();
          palette = selectPalette(config);
          cache = undefined;
          await refresh(ctx, true);
        }
        return;
      }

      ctx.ui.notify(formatConfig(config), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig();
    palette = selectPalette(config);
    if (isOpenAICodexModel(ctx.model)) void refresh(ctx, false);
    else clearWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (isOpenAICodexModel(ctx.model)) void refresh(ctx, false);
    else clearWidget(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (isOpenAICodexModel(event.model)) void refresh(ctx, false, event.model);
    else clearWidget(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (isOpenAICodexModel(ctx.model)) void refresh(ctx, true);
  });

  pi.on("session_shutdown", (_event, ctx) => clearWidget(ctx));
}

function isOpenAICodexModel(model: Pick<PiModel, "provider"> | undefined): boolean {
  return model?.provider === CODEX_PROVIDER_ID;
}

async function queryUsage(
  ctx: ExtensionContext,
  timeoutMs: number,
): Promise<QueryUsageResult> {
  const errors: UsageQueryError[] = [];

  try {
    return { ok: true, report: await queryViaPiAuth(ctx, timeoutMs) };
  } catch (cause) {
    errors.push({ source: "pi-auth", message: errorMessage(cause), cause });
  }

  try {
    return { ok: true, report: await queryViaCodexAppServer(timeoutMs) };
  } catch (cause) {
    errors.push({
      source: "codex-app-server",
      message: errorMessage(cause),
      cause,
    });
  }

  return { ok: false, errors };
}

async function queryViaPiAuth(
  ctx: ExtensionContext,
  timeoutMs: number,
): Promise<UsageReport> {
  const auth = await resolvePiCodexAuth(ctx);
  if (!auth) throw new Error("No Pi OpenAI Codex subscription auth is available.");

  const response = await fetchWithTimeout(
    CODEX_USAGE_URL,
    { headers: auth.headers },
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
    );
  }

  return normalizeBackendPayload(
    parseJsonObject(text, "Codex usage endpoint response") as RateLimitStatusPayload,
  );
}

async function resolvePiCodexAuth(
  ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
  const errors: string[] = [];
  for (const model of codexAuthCandidateModels(ctx)) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      errors.push(auth.error);
      continue;
    }

    const headers = { ...(auth.headers ?? {}) };
    if (!hasHeader(headers, "Authorization") && auth.apiKey) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }
    if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-codex-usage-bars";
    if (hasHeader(headers, "Authorization")) return { headers };
  }

  if (errors.length > 0) throw new Error(errors.join("; "));
  return undefined;
}

function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== CODEX_PROVIDER_ID) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s fetching Codex usage.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function queryViaCodexAppServer(timeoutMs: number): Promise<UsageReport> {
  const client = new CodexAppServerClient(timeoutMs);
  try {
    await client.start();
    await client.request("initialize", {
      clientInfo: {
        name: "pi_codex_usage_bars",
        title: "Pi Codex Usage Bars",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    client.notify("initialized");
    const result = await client.request("account/rateLimits/read", undefined);
    return normalizeAppServerResponse(
      assertObject(result, "account/rateLimits/read result") as AppServerRateLimitResponse,
    );
  } finally {
    client.dispose();
  }
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<number, PendingRpc>();
  private startPromise?: Promise<void>;
  private exitError?: Error;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const startupTimeout = setTimeout(() => {
        reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`));
      }, this.timeoutMs);

      child.once("spawn", () => {
        clearTimeout(startupTimeout);
        resolve();
      });

      child.once("error", (error) => {
        clearTimeout(startupTimeout);
        reject(new Error(`Failed to start codex app-server: ${error.message}`));
        this.rejectAll(error);
      });

      child.once("exit", (code, signal) => {
        const suffix = this.stderr ? ` stderr: ${redactErrorBody(this.stderr)}` : "";
        this.exitError = new Error(
          `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${suffix}`,
        );
        this.rejectAll(this.exitError);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
      });

      createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    });

    return this.startPromise;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("codex app-server is not running.");
    if (this.exitError) throw this.exitError;

    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method: string): void {
    const child = this.child;
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`codex app-server request ${id} cancelled.`));
    }
    this.pending.clear();

    const child = this.child;
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill();
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);

    if (parsed.error) {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
      pending.reject(new Error(`codex app-server request failed: ${message}`));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function normalizeBackendPayload(payload: RateLimitStatusPayload): UsageReport {
  const snapshots: RateLimitSnapshot[] = [];
  const primary = normalizeBackendSnapshot("codex", undefined, payload.rate_limit);
  if (primary) snapshots.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const item of additional) {
    const additionalLimit = assertObject(item, "additional rate limit") as BackendAdditionalRateLimit;
    const limitId = asString(additionalLimit.metered_feature) ?? asString(additionalLimit.limit_name);
    if (!limitId) continue;
    const snapshot = normalizeBackendSnapshot(
      limitId,
      asString(additionalLimit.limit_name),
      additionalLimit.rate_limit,
    );
    if (snapshot) snapshots.push(snapshot);
  }

  if (snapshots.length === 0) throw new Error("Codex usage endpoint returned no displayable rate-limit windows.");
  return { snapshots };
}

function normalizeBackendSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
): RateLimitSnapshot | undefined {
  if (rateLimit === null || rateLimit === undefined) return undefined;
  const details = assertObject(rateLimit, "rate limit") as BackendRateLimitDetails;
  const primary = normalizeBackendWindow(details.primary_window);
  const secondary = normalizeBackendWindow(details.secondary_window);
  if (!primary && !secondary) return undefined;
  return { limitId, limitName, primary, secondary };
}

function normalizeBackendWindow(value: unknown): RateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "rate-limit window") as BackendWindowSnapshot;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  return { usedPercent, resetsAt: asNumber(window.reset_at) };
}

function normalizeAppServerResponse(response: AppServerRateLimitResponse): UsageReport {
  const snapshots: RateLimitSnapshot[] = [];
  const addSnapshot = (raw: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
    if (!snapshot) return;
    const existingIndex = snapshots.findIndex((item) => item.limitId === snapshot.limitId);
    if (existingIndex >= 0) snapshots[existingIndex] = mergeSnapshot(snapshots[existingIndex], snapshot);
    else snapshots.push(snapshot);
  };

  addSnapshot(response.rateLimits, "codex");
  if (response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object") {
    for (const [limitId, raw] of Object.entries(response.rateLimitsByLimitId)) addSnapshot(raw, limitId);
  }

  if (snapshots.length === 0) throw new Error("codex app-server returned no displayable rate-limit windows.");
  return { snapshots };
}

function normalizeAppServerSnapshot(raw: unknown, fallbackId: string): RateLimitSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(raw, "app-server rate-limit snapshot") as AppServerRateLimitSnapshot;
  const limitId = asString(snapshot.limitId) ?? fallbackId;
  const limitName = asString(snapshot.limitName);
  const primary = normalizeAppServerWindow(snapshot.primary);
  const secondary = normalizeAppServerWindow(snapshot.secondary);
  if (!primary && !secondary) return undefined;
  return { limitId, limitName, primary, secondary };
}

function normalizeAppServerWindow(value: unknown): RateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "app-server rate-limit window") as AppServerWindowSnapshot;
  const usedPercent = asNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  return { usedPercent, resetsAt: asNumber(window.resetsAt) };
}

function mergeSnapshot(left: RateLimitSnapshot, right: RateLimitSnapshot): RateLimitSnapshot {
  return {
    limitId: right.limitId || left.limitId,
    limitName: right.limitName ?? left.limitName,
    primary: right.primary ?? left.primary,
    secondary: right.secondary ?? left.secondary,
  };
}

function setDisplay(
  ctx: ExtensionContext,
  lines: string[],
  config: Pick<ExtensionConfig, "align" | "layout" | "title" | "titleColor">,
): void {
  const titleLine = formatTitleLine(config);
  const displayLines = titleLine
    ? config.layout === "row"
      ? [`${titleLine}  ${lines.join("  ")}`]
      : [titleLine, ...lines]
    : lines;
  const cleanLines = displayLines.map((line) => line.replace(/[\r\n\t]/g, " "));
  if (config.layout === "column") {
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, alignLines(cleanLines, config.align), {
      placement: "belowEditor",
    });
    return;
  }

  ctx.ui.setWidget(WIDGET_KEY, undefined);
  ctx.ui.setStatus(WIDGET_KEY, alignLine(cleanLines.join("  "), config.align));
}

function alignLines(lines: string[], align: Alignment): string[] {
  return lines.map((line) => alignLine(line, align));
}

function alignLine(line: string, align: Alignment): string {
  if (align === "left") return line;
  const width = process.stdout.columns || 0;
  const textWidth = visibleLength(line);
  const totalPadding = Math.max(0, width - textWidth);
  const leftPadding = align === "center" ? Math.floor(totalPadding / 2) : totalPadding;
  return `${RIGHT_PAD.repeat(leftPadding)}${line}`;
}

function formatTitleLine(config: Pick<ExtensionConfig, "title" | "titleColor">): string | undefined {
  const title = config.title.trim();
  if (!title) return undefined;
  const rgb = config.titleColor === "fixed"
    ? activePalette.colors?.title ?? activePalette.palette.title
    : activePalette.palette.title;
  return color(rgb, title);
}

let activePalette: { palette: SessionPalette; colors?: Partial<Record<keyof SessionPalette, Rgb>> } = {
  palette: PALETTES[0],
};

function formatDisplay(
  report: UsageReport,
  palette: SessionPalette,
  config: Pick<ExtensionConfig, "barWidth" | "layout" | "bars">,
): string[] {
  const snapshot = selectPrimaryCodexSnapshot(report);
  if (!snapshot) return [dim("codex usage unavailable")];

  const parts: string[] = [];
  if (snapshot.primary && (config.bars === "both" || config.bars === "primary")) {
    parts.push(formatUsageLine(snapshot.primary, palette.primaryStart, palette.primaryEnd, palette.empty, config.barWidth));
  }
  if (snapshot.secondary && (config.bars === "both" || config.bars === "secondary")) {
    parts.push(formatUsageLine(snapshot.secondary, palette.secondaryStart, palette.secondaryEnd, palette.empty, config.barWidth));
  }
  if (parts.length === 0) return [dim("codex usage unavailable")];
  return config.layout === "column" ? parts : [parts.join("  ")];
}

function selectPrimaryCodexSnapshot(report: UsageReport): RateLimitSnapshot | undefined {
  return report.snapshots.find(isPrimaryCodexSnapshot) ?? report.snapshots[0];
}

function isPrimaryCodexSnapshot(snapshot: RateLimitSnapshot): boolean {
  return normalizedUsageKey(snapshot.limitId) === "codex" || normalizedUsageKey(snapshot.limitName) === "codex";
}

function formatUsageLine(
  window: RateLimitWindow,
  start: Rgb,
  end: Rgb,
  empty: Rgb,
  barWidth: number,
): string {
  const remaining = 100 - clampPercent(window.usedPercent);
  const filled = Math.round((remaining / 100) * barWidth);
  const chars: string[] = [];
  for (let index = 0; index < barWidth; index++) {
    if (index < filled) chars.push(color(lerpRgb(start, end, index / Math.max(1, barWidth - 1)), FILLED));
    else chars.push(color(empty, EMPTY));
  }
  return `${chars.join("")}  ${dim(`(${formatTimeUntil(window.resetsAt)})`)}`;
}

function formatTimeUntil(epochSeconds: number | undefined): string {
  if (!epochSeconds) return "—";
  const seconds = Math.max(0, Math.round(epochSeconds - Date.now() / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}`;
  return `${minutes}m`;
}

type ConfigDesignerTheme = {
  accent: (text: string) => string;
  selected: (text: string) => string;
  muted: (text: string) => string;
  dim: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
};

type ColorKey = keyof SessionPalette;
type HslChannel = "h" | "s" | "l";

type Hsl = { h: number; s: number; l: number };

class ConfigDesigner {
  onDone?: (value: ExtensionConfig | "edit-title" | null) => void;
  private selected = 0;
  private colorChannel: HslChannel = "h";
  private config: ExtensionConfig;
  private readonly theme: ConfigDesignerTheme;
  getConfig(): ExtensionConfig {
    return this.config;
  }

  private readonly colorKeys: Array<Exclude<ColorKey, "title">> = [
    "primaryStart",
    "primaryEnd",
    "secondaryStart",
    "secondaryEnd",
    "empty",
  ];

  constructor(config: ExtensionConfig, theme: ConfigDesignerTheme) {
    this.config = cloneConfigForDesigner(config);
    this.theme = theme;
  }

  handleInput(data: string): void {
    if (isKey(data, "escape")) {
      this.onDone?.(null);
      return;
    }
    if (isKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (isKey(data, "down")) {
      this.selected = Math.min(this.items().length - 1, this.selected + 1);
      return;
    }
    if (isKey(data, "tab")) {
      this.colorChannel = nextHslChannel(this.colorChannel);
      return;
    }
    if (isKey(data, "left")) {
      this.adjustSelected(-1);
      return;
    }
    if (isKey(data, "right")) {
      this.adjustSelected(1);
      return;
    }
    if (isKey(data, "enter")) {
      this.activateSelected();
      return;
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.accent("Codex usage bars config"));
    lines.push(this.theme.dim("↑↓ or j/k move • ←/→ or h/l adjust • tab H/S/L • enter edit/toggle/save • q/esc cancel"));
    lines.push(this.theme.dim("Resize note: alignment updates on refresh; run /codex-usage-bars-refresh for immediate resize fixes."));
    lines.push("");
    selectPalette(this.config);
    const titleLine = formatTitleLine(this.config);
    const previewLines = formatDisplay(mockReport(), activePalette.palette, this.config);
    const displayPreview = titleLine
      ? this.config.layout === "row"
        ? [`${titleLine}  ${previewLines.join("  ")}`]
        : [titleLine, ...previewLines]
      : previewLines;
    lines.push(...displayPreview.map((line) => `Preview  ${line}`));
    lines.push("");

    const items = this.items();
    for (let index = 0; index < items.length; index++) {
      const prefix = index === this.selected ? "› " : "  ";
      const raw = `${prefix}${items[index]}`;
      const line = index === this.selected ? this.theme.selected(raw) : raw;
      lines.push(line);
    }

    lines.push("");
    lines.push(this.theme.dim(`Config file: ${getConfigPath()}`));
    return lines.map((line) => truncateAnsiLine(line, width));
  }

  invalidate(): void {}

  private items(): string[] {
    return [
      `Align: ${this.config.align}`,
      `Layout: ${this.config.layout}`,
      `Bar width: ${this.config.barWidth}  (large values may truncate on small windows)`,
      `Auto refresh: ${this.config.refreshIntervalMs <= 0 ? "off (still refreshes on session updates)" : `${Math.round(this.config.refreshIntervalMs / 1000)}s`}`,
      `Bars: ${formatBarSelection(this.config.bars)}`,
      `Palette: ${this.config.palette}`,
      ...(this.config.palette === "fixed" ? this.colorKeys.map((key) => this.colorItem(key)) : []),
      `Title: ${this.config.title ? JSON.stringify(this.config.title) : "(empty)"}  (enter to edit, ←/→ presets)`, 
      ...(this.config.title ? [`Title color: ${this.config.titleColor}`] : []),
      ...(this.config.title && this.config.titleColor === "fixed" ? [this.colorItem("title")] : []),
      this.theme.success("Save config"),
      this.theme.warning("Cancel"),
    ];
  }

  private colorItem(key: ColorKey): string {
    const rgb = this.config.colors?.[key] ?? PALETTES[0][key];
    const hsl = rgbToHsl(rgb);
    const swatch = color(rgb, "████");
    return `${labelColorKey(key)}: ${swatch} ${rgbToHex(rgb)}  H ${slider(hsl.h, 360, this.colorChannel === "h")} S ${slider(hsl.s, 100, this.colorChannel === "s")} L ${slider(hsl.l, 100, this.colorChannel === "l")}`;
  }

  private activateSelected(): void {
    const itemCount = this.items().length;
    if (this.selected === 0) this.config.align = nextAlignment(this.config.align);
    else if (this.selected === 1) this.config.layout = this.config.layout === "row" ? "column" : "row";
    else if (this.selected === 4) this.config.bars = nextBarSelection(this.config.bars);
    else if (this.selected === 5) {
      this.config.palette = this.config.palette === "random" ? "fixed" : "random";
      this.selected = Math.min(this.selected, this.items().length - 1);
    }
    else if (this.isTitleRow()) this.onDone?.("edit-title");
    else if (this.isTitleColorRow()) this.config.titleColor = this.config.titleColor === "random" ? "fixed" : "random";
    else if (this.selected === itemCount - 2) this.onDone?.(this.config);
    else if (this.selected === itemCount - 1) this.onDone?.(null);
  }

  private adjustSelected(delta: number): void {
    if (this.selected === 0 || this.selected === 1 || this.selected === 4) {
      this.activateSelected();
      return;
    }
    if (this.selected === 2) {
      this.config.barWidth = Math.min(40, Math.max(4, this.config.barWidth + delta));
      return;
    }
    if (this.selected === 3) {
      this.config.refreshIntervalMs = Math.min(600_000, Math.max(0, this.config.refreshIntervalMs + delta * 5_000));
      return;
    }
    if (this.selected === 4) {
      this.config.bars = delta >= 0 ? nextBarSelection(this.config.bars) : previousBarSelection(this.config.bars);
      return;
    }

    if (this.isTitleRow()) {
      this.cycleTitle(delta);
      return;
    }
    if (this.isTitleColorRow()) {
      this.config.titleColor = this.config.titleColor === "random" ? "fixed" : "random";
      return;
    }

    const titleColorIndex = this.titleColorRowIndex();
    if (this.selected === titleColorIndex + 1 && this.config.title && this.config.titleColor === "fixed") {
      this.adjustColor("title", delta);
      return;
    }

    if (this.config.palette !== "fixed") return;

    const colorIndex = this.selected - 6;
    const key = this.colorKeys[colorIndex];
    if (!key) return;
    this.adjustColor(key, delta);
  }

  private adjustColor(key: keyof SessionPalette, delta: number): void {
    if (key === "title") this.config.titleColor = "fixed";
    else this.config.palette = "fixed";
    this.config.colors ??= {};
    const current = this.config.colors[key] ?? PALETTES[0][key];
    const hsl = rgbToHsl(current);
    const step = this.colorChannel === "h" ? 5 : 2;
    hsl[this.colorChannel] = clamp(
      hsl[this.colorChannel] + delta * step,
      0,
      this.colorChannel === "h" ? 360 : 100,
    );
    this.config.colors[key] = hslToRgb(hsl);
  }

  private titleRowIndex(): number {
    return 6 + (this.config.palette === "fixed" ? this.colorKeys.length : 0);
  }

  private titleColorRowIndex(): number {
    return this.titleRowIndex() + 1;
  }

  private isTitleRow(): boolean {
    return this.selected === this.titleRowIndex();
  }

  private isTitleColorRow(): boolean {
    return this.config.title !== "" && this.selected === this.titleColorRowIndex();
  }

  private cycleTitle(direction = 1): void {
    const titles = ["", "CODEX", "CODEX USAGE", "USAGE", "LIMITS", this.config.title].filter((value, index, array) => array.indexOf(value) === index);
    const currentIndex = Math.max(0, titles.indexOf(this.config.title));
    const nextIndex = (currentIndex + direction + titles.length) % titles.length;
    this.config.title = titles[nextIndex] ?? "";
    this.selected = Math.min(this.selected, this.items().length - 1);
  }
}

function cloneConfigForDesigner(config: ExtensionConfig): ExtensionConfig {
  return {
    ...config,
    colors: {
      title: config.colors?.title ?? PALETTES[0].title,
      primaryStart: config.colors?.primaryStart ?? PALETTES[0].primaryStart,
      primaryEnd: config.colors?.primaryEnd ?? PALETTES[0].primaryEnd,
      secondaryStart: config.colors?.secondaryStart ?? PALETTES[0].secondaryStart,
      secondaryEnd: config.colors?.secondaryEnd ?? PALETTES[0].secondaryEnd,
      empty: config.colors?.empty ?? PALETTES[0].empty,
    },
  };
}

function isKey(
  data: string,
  key: "escape" | "up" | "down" | "left" | "right" | "tab" | "enter",
): boolean {
  if (key === "escape") return data === "\x1b" || data === "q" || data === "Q";
  if (key === "up") return data === "k" || data === "K" || data.endsWith("[A") || data.endsWith("OA");
  if (key === "down") return data === "j" || data === "J" || data.endsWith("[B") || data.endsWith("OB");
  if (key === "right") return data === "l" || data === "L" || data.endsWith("[C") || data.endsWith("OC");
  if (key === "left") return data === "h" || data === "H" || data.endsWith("[D") || data.endsWith("OD");
  if (key === "tab") return data === "\t" || data === "]";
  if (key === "enter") return data === "\r" || data === "\n" || data === "s" || data === "S";
  return false;
}

function truncateAnsiLine(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  let result = "";
  let visible = 0;
  for (let index = 0; index < line.length && visible < Math.max(0, width - 1); index++) {
    if (line[index] === "\x1b") {
      const match = line.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        result += match[0];
        index += match[0].length - 1;
        continue;
      }
    }
    result += line[index];
    visible += 1;
  }
  return `${result}…\x1b[0m`;
}

function nextAlignment(align: Alignment): Alignment {
  if (align === "left") return "center";
  if (align === "center") return "right";
  return "left";
}

function nextBarSelection(bars: BarSelection): BarSelection {
  if (bars === "both") return "primary";
  if (bars === "primary") return "secondary";
  return "both";
}

function previousBarSelection(bars: BarSelection): BarSelection {
  if (bars === "both") return "secondary";
  if (bars === "secondary") return "primary";
  return "both";
}

function formatBarSelection(bars: BarSelection): string {
  if (bars === "primary") return "5h only";
  if (bars === "secondary") return "weekly only";
  return "both";
}

function nextHslChannel(channel: HslChannel): HslChannel {
  if (channel === "h") return "s";
  if (channel === "s") return "l";
  return "h";
}

function labelColorKey(key: ColorKey): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function slider(value: number, max: number, active: boolean): string {
  const width = 10;
  const filled = Math.round((value / max) * width);
  const body = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  const text = `[${body}] ${Math.round(value).toString().padStart(3, " ")}`;
  return active ? `*${text}*` : text;
}

function mockReport(): UsageReport {
  return {
    snapshots: [
      {
        limitId: "codex",
        primary: { usedPercent: 45, resetsAt: Date.now() / 1000 + 3.5 * 60 * 60 },
        secondary: { usedPercent: 18, resetsAt: Date.now() / 1000 + 4 * 24 * 60 * 60 + 6 * 60 * 60 },
      },
    ],
  };
}

function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(hsl: Hsl): Rgb {
  const h = hsl.h / 360;
  const s = hsl.s / 100;
  const l = hsl.l / 100;
  if (s === 0) {
    const value = Math.round(l * 255);
    return [value, value, value];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return Math.round((p + (q - p) * 6 * value) * 255);
  if (value < 1 / 2) return Math.round(q * 255);
  if (value < 2 / 3) return Math.round((p + (q - p) * (2 / 3 - value) * 6) * 255);
  return Math.round(p * 255);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function designConfig(
  ctx: ExtensionContext,
  currentConfig: ExtensionConfig,
): Promise<boolean> {
  let draftConfig: ExtensionConfig = currentConfig;
  let editingTitle = false;
  let next = await ctx.ui.custom<ExtensionConfig | "edit-title" | null>((tui, theme, _keybindings, done) => {
    const designer = new ConfigDesigner(currentConfig, {
      accent: (text) => theme.fg("accent", text),
      selected: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
      muted: (text) => theme.fg("muted", text),
      dim: (text) => theme.fg("dim", text),
      success: (text) => theme.fg("success", text),
      warning: (text) => theme.fg("warning", text),
    });
    designer.onDone = (value) => {
      if (value && value !== "edit-title") draftConfig = value;
      if (value === "edit-title") draftConfig = designer.getConfig();
      done(value);
    };
    return {
      render: (width) => designer.render(width),
      invalidate: () => designer.invalidate(),
      handleInput: (data) => {
        designer.handleInput(data);
        tui.requestRender();
        return true;
      },
    };
  });

  if (next === "edit-title") {
    editingTitle = true;
  }

  if (editingTitle) {
    const title = await ctx.ui.input("Codex usage bars title", draftConfig.title || "");
    if (title === undefined) return designConfig(ctx, draftConfig);
    const updated = { ...draftConfig, title };
    return designConfig(ctx, updated);
  }

  if (!next) return false;
  writeConfig(configToFile(next));
  ctx.ui.notify(`Saved ${getConfigPath()}`, "info");
  return true;
}

async function editConfigFile(
  ctx: ExtensionContext,
  currentConfig: ExtensionConfig,
): Promise<boolean> {
  const configPath = getConfigPath();
  const initial = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : JSON.stringify(configToFile(currentConfig), null, 2);

  const edited = await ctx.ui.editor(
    `Edit ${configPath}`,
    `${initial.trim()}\n`,
  );
  if (edited === undefined) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(edited);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object.");
    }
    normalizeConfig({
      align: "right",
      layout: "row",
      barWidth: DEFAULT_BAR_WIDTH,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      bars: "both",
      palette: "random",
      title: "",
      titleColor: "random",
      ...parseRawConfig(parsed as Record<string, unknown>),
    });
  } catch (error) {
    ctx.ui.notify(`Config not saved: ${errorMessage(error)}`, "error");
    return false;
  }

  writeConfig(parsed as Record<string, unknown>);
  ctx.ui.notify(`Saved ${configPath}`, "info");
  return true;
}

function writeConfig(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function configToFile(config: ExtensionConfig): Record<string, unknown> {
  const file: Record<string, unknown> = {
    align: config.align,
    layout: config.layout,
    barWidth: config.barWidth,
    refreshIntervalMs: config.refreshIntervalMs,
    bars: config.bars,
    palette: config.palette,
    title: config.title,
    titleColor: config.titleColor,
  };

  const colors: Record<string, string> = {};
  if (config.title && config.titleColor === "fixed") {
    colors.title = rgbToHex(config.colors?.title ?? PALETTES[0].title);
  }
  if (config.palette === "fixed") {
    colors.primaryStart = rgbToHex(config.colors?.primaryStart ?? PALETTES[0].primaryStart);
    colors.primaryEnd = rgbToHex(config.colors?.primaryEnd ?? PALETTES[0].primaryEnd);
    colors.secondaryStart = rgbToHex(config.colors?.secondaryStart ?? PALETTES[0].secondaryStart);
    colors.secondaryEnd = rgbToHex(config.colors?.secondaryEnd ?? PALETTES[0].secondaryEnd);
    colors.empty = rgbToHex(config.colors?.empty ?? PALETTES[0].empty);
  }
  if (Object.keys(colors).length > 0) file.colors = colors;

  return file;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function formatConfig(config: ExtensionConfig): string {
  return [
    "Codex usage bars config:",
    `align: ${config.align}`,
    `layout: ${config.layout}`,
    `barWidth: ${config.barWidth}`,
    `refreshIntervalMs: ${config.refreshIntervalMs}`,
    `bars: ${config.bars}`,
    `palette: ${config.palette}`,
    `title: ${config.title || "(empty)"}`,
    `titleColor: ${config.titleColor}`,
    `configFile: ${getConfigPath()}`,
  ].join("\n");
}

function loadConfig(): ExtensionConfig {
  const defaults: ExtensionConfig = {
    align: "right",
    layout: "row",
    barWidth: DEFAULT_BAR_WIDTH,
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    bars: "both",
    palette: "random",
    title: "",
    titleColor: "random",
  };

  const fileConfig = readConfigFile();
  const envConfig = readEnvConfig();
  return normalizeConfig({ ...defaults, ...fileConfig, ...envConfig });
}

function getConfigPath(): string {
  return process.env.CODEX_USAGE_BARS_CONFIG ??
    join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "codex-usage-bars.json");
}

function readConfigFile(): Partial<ExtensionConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return { palette: "random" };

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return parseRawConfig(raw);
  } catch {
    return {};
  }
}

function readEnvConfig(): Partial<ExtensionConfig> {
  return parseRawConfig({
    align: process.env.CODEX_USAGE_BARS_ALIGN,
    layout: process.env.CODEX_USAGE_BARS_LAYOUT,
    barWidth: process.env.CODEX_USAGE_BARS_BAR_WIDTH,
    refreshIntervalMs: process.env.CODEX_USAGE_BARS_REFRESH_MS,
    bars: process.env.CODEX_USAGE_BARS_BARS,
    palette: process.env.CODEX_USAGE_BARS_PALETTE,
    title: process.env.CODEX_USAGE_BARS_TITLE,
    titleColor: process.env.CODEX_USAGE_BARS_TITLE_COLOR,
    colors: {
      title: process.env.CODEX_USAGE_BARS_TITLE_FIXED_COLOR,
      primaryStart: process.env.CODEX_USAGE_BARS_PRIMARY_START,
      primaryEnd: process.env.CODEX_USAGE_BARS_PRIMARY_END,
      secondaryStart: process.env.CODEX_USAGE_BARS_SECONDARY_START,
      secondaryEnd: process.env.CODEX_USAGE_BARS_SECONDARY_END,
      empty: process.env.CODEX_USAGE_BARS_EMPTY,
    },
  });
}

function parseRawConfig(raw: Record<string, unknown>): Partial<ExtensionConfig> {
  const config: Partial<ExtensionConfig> = {};
  if (raw.align === "left" || raw.align === "center" || raw.align === "right") config.align = raw.align;
  if (raw.layout === "row" || raw.layout === "column") config.layout = raw.layout;
  if (raw.bars === "both" || raw.bars === "primary" || raw.bars === "secondary") config.bars = raw.bars;
  if (raw.palette === "random" || raw.palette === "fixed") config.palette = raw.palette;
  if (typeof raw.title === "string") config.title = raw.title;
  if (raw.titleColor === "random" || raw.titleColor === "fixed") config.titleColor = raw.titleColor;

  const barWidth = asNumber(raw.barWidth);
  if (barWidth !== undefined) config.barWidth = barWidth;

  const refreshIntervalMs = asNumber(raw.refreshIntervalMs);
  if (refreshIntervalMs !== undefined) config.refreshIntervalMs = refreshIntervalMs;

  const rawColors = raw.colors && typeof raw.colors === "object" && !Array.isArray(raw.colors)
    ? (raw.colors as Record<string, unknown>)
    : raw;
  const colors: Partial<Record<keyof SessionPalette, Rgb>> = {};
  for (const key of ["title", "primaryStart", "primaryEnd", "secondaryStart", "secondaryEnd", "empty"] as const) {
    const parsed = parseRgb(rawColors[key]);
    if (parsed) colors[key] = parsed;
  }
  if (Object.keys(colors).length > 0) {
    config.colors = colors;
    if (colors.title && config.title) config.titleColor ??= "fixed";
    if (colors.primaryStart || colors.primaryEnd || colors.secondaryStart || colors.secondaryEnd || colors.empty) {
      config.palette ??= "fixed";
    }
  }

  return config;
}

function normalizeConfig(config: ExtensionConfig): ExtensionConfig {
  return {
    ...config,
    barWidth: Math.min(40, Math.max(4, Math.round(config.barWidth))),
    refreshIntervalMs: Math.min(10 * 60_000, Math.max(0, Math.round(config.refreshIntervalMs))),
  };
}

function parseRgb(value: unknown): Rgb | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return undefined;
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function selectPalette(config: ExtensionConfig): SessionPalette {
  const base = config.palette === "fixed" ? PALETTES[0] : randomPalette();
  const colors = { ...(config.colors ?? {}) };
  if (config.titleColor !== "fixed") delete colors.title;
  const palette = { ...base, ...colors };
  activePalette = { palette, colors: config.colors };
  return palette;
}

function randomPalette(): SessionPalette {
  return PALETTES[Math.floor(Math.random() * PALETTES.length)] ?? PALETTES[0];
}

function color(rgb: Rgb, text: string): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

function lerpRgb(start: Rgb, end: Rgb, t: number): Rgb {
  return [
    Math.round(start[0] + (end[0] - start[0]) * t),
    Math.round(start[1] + (end[1] - start[1]) * t),
    Math.round(start[2] + (end[2] - start[2]) * t),
  ];
}

function statusErrorText(errors: UsageQueryError[]): string {
  if (errors.some((error) => isUnavailableMessage(error.message))) return "n/a";
  return "usage error";
}

function isUnavailableMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no pi openai codex subscription auth") ||
    lower.includes("no displayable rate-limit windows") ||
    lower.includes("returned 401") ||
    lower.includes("returned 403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("subscription") ||
    lower.includes("no active plan")
  );
}

function parseJsonObject(text: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${description} was not valid JSON: ${errorMessage(error)}`);
  }
  return assertObject(parsed, description);
}

function assertObject(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
