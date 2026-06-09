import type { FileSyncState } from "../sync/sync-engine";

const GLYPH: Record<FileSyncState, string> = { synced: "✓", pending: "⟳", error: "⚠" };
const BADGE_CLASS = "nb-sync-badge";
const STYLE_ID = "nb-sync-badge-style";

export class FileBadges {
  private readonly states = new Map<string, FileSyncState>();
  private observer: MutationObserver | null = null;
  private repaintQueued = false;

  constructor(private readonly label: (s: FileSyncState) => string) {}

  start(): void {
    this.injectStyle();
    const container = document.querySelector(".nav-files-container") ?? document.body;
    this.observer = new MutationObserver(() => this.queueRepaint());
    this.observer.observe(container, { childList: true, subtree: true });
    this.repaintAll();
  }

  setState(path: string, state: FileSyncState): void {
    if (this.states.get(path) === state) return;
    this.states.set(path, state);
    this.paintOne(path);
  }

  clear(path: string): void {
    this.states.delete(path);
    const el = this.titleEl(path);
    if (el) this.badgeOf(el)?.remove();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((b) => b.remove());
    document.getElementById(STYLE_ID)?.remove();
    this.states.clear();
  }

  private queueRepaint(): void {
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    setTimeout(() => {
      this.repaintQueued = false;
      this.repaintAll();
    }, 50);
  }

  private repaintAll(): void {
    for (const path of this.states.keys()) this.paintOne(path);
  }

  private titleEl(path: string): HTMLElement | null {
    const esc = (window.CSS && CSS.escape ? CSS.escape(path) : path.replace(/"/g, '\\"'));
    return document.querySelector<HTMLElement>(`.nav-file-title[data-path="${esc}"]`);
  }

  private badgeOf(titleEl: HTMLElement): HTMLElement | null {
    return titleEl.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
  }

  private paintOne(path: string): void {
    const state = this.states.get(path);
    const el = this.titleEl(path);
    if (!el || !state) return;
    let badge = this.badgeOf(el);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = BADGE_CLASS;
      el.appendChild(badge);
    }
    badge.textContent = GLYPH[state];
    badge.dataset.nbState = state;
    badge.setAttribute("aria-label", this.label(state));
    badge.title = this.label(state);
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${BADGE_CLASS} { margin-left: auto; padding-left: 6px; font-size: 0.85em; line-height: 1; flex: 0 0 auto; }
      .${BADGE_CLASS}[data-nb-state="synced"] { color: var(--color-green, #3aa757); }
      .${BADGE_CLASS}[data-nb-state="pending"] { color: var(--text-muted, #888); }
      .${BADGE_CLASS}[data-nb-state="error"] { color: var(--color-orange, #e0823d); }
    `;
    document.head.appendChild(style);
  }
}
