import {
  Loader,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

const FRAME_INTERVAL_MS = 80;
const MOON_FRAME_INTERVAL_MS = 80;

type SpinnerMode = "thinking" | "responding" | "tool_use";

// kimi-cli moon spinner frames
const MOON_FRAMES = ["🌑 ", "🌒 ", "🌓 ", "🌔 ", "🌕 ", "🌖 ", "🌗 ", "🌘 "];

interface Clock {
  subscribe(onChange: () => void, keepAlive: boolean): () => void;
  now(): number;
  setTickInterval(ms: number): void;
}

function createClock(tickIntervalMs: number): Clock {
  const subscribers = new Map<() => void, boolean>();
  let keepAliveCount = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentTickIntervalMs = tickIntervalMs;
  let startTime = 0;
  let tickTime = 0;

  function tick(): void {
    tickTime = Date.now() - startTime;
    for (const onChange of subscribers.keys()) {
      onChange();
    }
  }

  function updateInterval(): void {
    if (keepAliveCount > 0) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (startTime === 0) {
        startTime = Date.now();
      }
      interval = setInterval(tick, currentTickIntervalMs);
      return;
    }

    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  return {
    subscribe(onChange, keepAlive) {
      const previous = subscribers.get(onChange);
      if (previous === undefined) {
        if (keepAlive) keepAliveCount += 1;
      } else if (previous !== keepAlive) {
        keepAliveCount += keepAlive ? 1 : -1;
      }
      subscribers.set(onChange, keepAlive);
      updateInterval();
      return () => {
        const existing = subscribers.get(onChange);
        if (existing === undefined) return;
        if (existing) keepAliveCount = Math.max(0, keepAliveCount - 1);
        subscribers.delete(onChange);
        updateInterval();
      };
    },
    now() {
      if (startTime === 0) {
        startTime = Date.now();
      }
      if (interval && tickTime) {
        return tickTime;
      }
      return Date.now() - startTime;
    },
    setTickInterval(ms) {
      if (ms === currentTickIntervalMs) return;
      currentTickIntervalMs = ms;
      updateInterval();
    },
  };
}

const spinnerClock = createClock(FRAME_INTERVAL_MS);

// -- Formatting helpers (kimi-cli style) ------------------------------------

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return "<1s";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return `${min}m ${sec.toString().padStart(2, "0")}s`;
  }
  const hr = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${hr}h ${min}m ${sec.toString().padStart(2, "0")}s`;
}

// -- Moon frame helper ------------------------------------------------------

function moonFrameFor(elapsedMs: number): string {
  const idx =
    Math.floor(elapsedMs / MOON_FRAME_INTERVAL_MS) % MOON_FRAMES.length;
  return MOON_FRAMES[idx]!;
}

// -- EnhancedSpinner --------------------------------------------------------

let activeSpinner: EnhancedSpinner | null = null;

export class EnhancedSpinner implements Component {
  private readonly unsubscribe: () => void;
  private mode: SpinnerMode = "thinking";
  private cachedLine = "";
  private readonly turnStartMs: number;

  constructor(
    private readonly tui: TUI,
    private readonly spinnerColorFn: (str: string) => string,
    private readonly messageColorFn: (str: string) => string,
    message = "Working...",
  ) {
    this.turnStartMs = spinnerClock.now();
    this.unsubscribe = spinnerClock.subscribe(() => {
      this.refresh();
      this.tui.requestRender();
    }, true);
    this.refresh();
  }

  stop(): void {
    this.unsubscribe();
    if (activeSpinner === this) {
      activeSpinner = null;
    }
  }

  setMessage(_message: string): void {
    // no-op: spinner no longer displays custom messages
  }

  setMode(mode: SpinnerMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
    }
    this.refresh();
    this.tui.requestRender();
  }

  updateEstimatedTokensFromText(_count: number): void {
    this.refresh();
    this.tui.requestRender();
  }

  setExactOutputTokens(_tokens: number): void {
    this.refresh();
    this.tui.requestRender();
  }

  // -- Rendering -----------------------------------------------------------

  private refresh(): void {
    const now = spinnerClock.now();
    const elapsedMs = now - this.turnStartMs;
    const elapsedStr = formatElapsed(elapsedMs);

    switch (this.mode) {
      case "thinking":
        this.cachedLine = this.renderThinking(elapsedMs, elapsedStr);
        break;
      case "responding":
        this.cachedLine = this.renderResponding(elapsedMs, elapsedStr);
        break;
      case "tool_use":
        this.cachedLine = this.renderToolUse(elapsedMs, elapsedStr);
        break;
    }
  }

  private renderThinking(
    elapsedMs: number,
    elapsedStr: string,
  ): string {
    const moon = moonFrameFor(elapsedMs);
    return `${moon}Thinking... (${elapsedStr})`;
  }

  private renderResponding(
    elapsedMs: number,
    elapsedStr: string,
  ): string {
    const moon = moonFrameFor(elapsedMs);
    return `${moon}Composing... (${elapsedStr})`;
  }

  private renderToolUse(elapsedMs: number, elapsedStr: string): string {
    const moon = moonFrameFor(elapsedMs);
    return `${moon}Using tools... (${elapsedStr})`;
  }

  // -- Component interface --------------------------------------------------

  render(width: number): string[] {
    return ["", truncateToWidth(this.cachedLine, width)];
  }

  invalidate(): void {
    this.refresh();
  }
}

// -- Public helpers ---------------------------------------------------------

export function getActiveSpinner(): EnhancedSpinner | null {
  return activeSpinner;
}

export function stopActiveSpinner(): void {
  activeSpinner?.stop();
  activeSpinner = null;
}

// -- Loader prototype patch -------------------------------------------------

export function patchLoaderPrototype(): void {
  const proto = Loader.prototype as unknown as {
    start?: () => void;
    stop: () => void;
    setMessage: (message: string) => void;
    updateDisplay?: () => void;
    render: (width: number) => string[];
    invalidate: () => void;
    __piCcUiEnhancedPatched?: boolean;
    [key: string]: unknown;
  };

  if (proto.__piCcUiEnhancedPatched) {
    return;
  }

  proto.__piCcUiEnhancedPatched = true;

  const originalStart = proto.start;
  const originalStop = proto.stop;
  const originalSetMessage = proto.setMessage;
  const originalUpdateDisplay = proto.updateDisplay;
  const originalRender = proto.render;
  const originalInvalidate = proto.invalidate;

  proto.start = function (this: typeof proto): void {
    const ui = (this as unknown as { ui?: TUI | null }).ui;
    const spinnerColorFn = (
      this as unknown as { spinnerColorFn: (value: string) => string }
    ).spinnerColorFn;
    const messageColorFn = (
      this as unknown as { messageColorFn: (value: string) => string }
    ).messageColorFn;
    const message = (this as unknown as { message: string }).message;

    if (!ui) {
      if (originalStart) originalStart.call(this);
      return;
    }

    const previousEnhanced = (this as { __enhanced?: EnhancedSpinner })
      .__enhanced;
    previousEnhanced?.stop();

    const enhanced = new EnhancedSpinner(
      ui,
      spinnerColorFn,
      messageColorFn,
      message,
    );
    (this as unknown as { __enhanced?: EnhancedSpinner }).__enhanced = enhanced;
    activeSpinner = enhanced;
  };

  proto.stop = function (this: typeof proto): void {
    const enhanced = (this as { __enhanced?: EnhancedSpinner }).__enhanced;
    if (enhanced) {
      enhanced.stop();
      delete (this as { __enhanced?: EnhancedSpinner }).__enhanced;
      return;
    }
    originalStop.call(this);
  };

  proto.setMessage = function (this: typeof proto, message: string): void {
    (this as { message?: string }).message = message;
    const enhanced = (this as { __enhanced?: EnhancedSpinner }).__enhanced;
    if (enhanced) {
      enhanced.setMessage(message);
      return;
    }
    originalSetMessage.call(this, message);
  };

  proto.render = function (this: typeof proto, width: number): string[] {
    const enhanced = (this as { __enhanced?: EnhancedSpinner }).__enhanced;
    if (enhanced) {
      return enhanced.render(width);
    }
    return originalRender.call(this, width);
  };

  proto.invalidate = function (this: typeof proto): void {
    const enhanced = (this as { __enhanced?: EnhancedSpinner }).__enhanced;
    if (enhanced) {
      enhanced.invalidate();
      return;
    }
    originalInvalidate.call(this);
  };

  proto.updateDisplay = function (this: typeof proto): void {
    const enhanced = (this as { __enhanced?: EnhancedSpinner }).__enhanced;
    if (enhanced) {
      enhanced.invalidate();
      return;
    }
    if (originalUpdateDisplay) {
      originalUpdateDisplay.call(this);
    }
  };
}
