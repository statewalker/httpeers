/**
 * The widget's own stylesheet, injected once per document.
 *
 * OWN CSS, NOT THE PAGE'S. The two pages that use it style in opposite ways:
 * the demos with a few plain element rules, llm-chat with Tailwind, whose
 * preflight strips every button of its border and background. Every rule here
 * is on an `hp-join-` class, so it neither leaks into the page nor depends on
 * it, and it is NOT in a cascade layer -- unlayered rules beat Tailwind's
 * `@layer base`, which is what keeps a button looking like a button under it.
 *
 * `font: inherit` everywhere: the widget takes the page's typeface and size.
 * Colours are custom properties on `.hp-join`, so a page re-themes it by
 * setting `--hp-join-accent` and friends instead of overriding selectors.
 */

export const JOIN_WIDGET_STYLE_ID = "hp-join-style";

export const JOIN_WIDGET_CSS = `
.hp-join {
  --hp-join-fg: #18181b;
  --hp-join-muted: #52525b;
  --hp-join-border: #d4d4d8;
  --hp-join-bg: #ffffff;
  --hp-join-accent: #1d4ed8;
  --hp-join-accent-fg: #ffffff;
  --hp-join-danger: #b91c1c;
  --hp-join-note-bg: #eff6ff;
  --hp-join-alert-bg: #fee2e2;
  --hp-join-live: #15803d;
  display: flex;
  flex-direction: column;
  gap: .6rem;
  font: inherit;
  color: var(--hp-join-fg);
}
.hp-join p { margin: 0; }
.hp-join [hidden] { display: none !important; }
.hp-join-status { display: flex; flex-wrap: wrap; align-items: baseline; gap: .2rem .6rem; }
.hp-join-phase { font-weight: 600; }
.hp-join-phase::before {
  content: ""; display: inline-block; width: .55em; height: .55em; border-radius: 50%;
  margin-right: .45em; vertical-align: .08em; background: var(--hp-join-muted);
}
.hp-join[data-phase="live"] .hp-join-phase::before { background: var(--hp-join-live); }
.hp-join[data-phase="blocked"] .hp-join-phase::before,
.hp-join[data-phase="failed"] .hp-join-phase::before { background: var(--hp-join-danger); }
.hp-join-peer {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em;
  color: var(--hp-join-muted); word-break: break-all;
}
.hp-join-message, .hp-join-error {
  padding: .6rem .8rem; border-radius: 6px; white-space: pre-wrap; font-size: .95em;
}
.hp-join-message { background: var(--hp-join-note-bg); }
.hp-join-message[role="alert"], .hp-join-error { background: var(--hp-join-alert-bg); }
.hp-join-form { display: flex; flex-direction: column; gap: .4rem; margin: 0; }
.hp-join-label { font-weight: 500; }
.hp-join-input {
  font: inherit; font-size: .9em; width: 100%; box-sizing: border-box; padding: .45rem .55rem;
  border: 1px solid var(--hp-join-border); border-radius: 6px; resize: vertical;
  background: var(--hp-join-bg); color: var(--hp-join-fg);
}
.hp-join-input:focus-visible, .hp-join-button:focus-visible, .hp-join-file:focus-within,
.hp-join-menu-toggle:focus-visible {
  outline: 2px solid var(--hp-join-accent); outline-offset: 2px;
}
.hp-join-actions, .hp-join-controls { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.hp-join-button {
  font: inherit; font-size: .95em; line-height: 1.3; padding: .4rem .8rem; cursor: pointer;
  border: 1px solid var(--hp-join-border); border-radius: 6px;
  background: var(--hp-join-bg); color: var(--hp-join-fg);
}
.hp-join-button:disabled { opacity: .5; cursor: default; }
.hp-join-primary {
  background: var(--hp-join-accent); border-color: var(--hp-join-accent); color: var(--hp-join-accent-fg);
}
.hp-join-danger { color: var(--hp-join-danger); }
.hp-join-file { display: inline-block; position: relative; }
.hp-join-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.hp-join-viewfinder {
  width: 100%; max-width: 22rem; min-height: 10rem; border-radius: 6px; overflow: hidden;
  background: #000;
}
.hp-join-viewfinder video { width: 100% !important; display: block; }
.hp-join-camera-stop { align-self: flex-start; }
.hp-join-compact { flex-direction: row; align-items: center; gap: .5rem; font-size: .8rem; }
.hp-join-compact .hp-join-phase::before { width: .5em; height: .5em; }
.hp-join-compact .hp-join-phase { font-weight: 500; color: var(--hp-join-muted); }
.hp-join-menu { position: relative; }
.hp-join-menu-toggle {
  cursor: pointer; list-style: none; padding: .1rem .45rem; border-radius: 6px;
  border: 1px solid var(--hp-join-border); color: var(--hp-join-muted);
}
.hp-join-menu-toggle::-webkit-details-marker { display: none; }
.hp-join-menu-panel {
  position: absolute; right: 0; top: calc(100% + .3rem); z-index: 20; width: max-content;
  max-width: min(22rem, 90vw); display: flex; flex-direction: column; gap: .5rem; padding: .6rem;
  background: var(--hp-join-bg); border: 1px solid var(--hp-join-border); border-radius: 8px;
  box-shadow: 0 6px 20px rgb(0 0 0 / .12);
}
`;

/** Add the stylesheet to `doc` unless it is already there. */
export function injectJoinWidgetStyles(doc: Document): void {
  if (doc.getElementById(JOIN_WIDGET_STYLE_ID) != null) return;
  const style = doc.createElement("style");
  style.id = JOIN_WIDGET_STYLE_ID;
  style.textContent = JOIN_WIDGET_CSS;
  doc.head.append(style);
}
