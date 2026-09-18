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
  max-width: min(22rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 5rem); overflow-y: auto;
  display: flex; flex-direction: column; gap: .5rem; padding: .6rem;
  background: var(--hp-join-bg); border: 1px solid var(--hp-join-border); border-radius: 8px;
  box-shadow: 0 6px 20px rgb(0 0 0 / .12);
}
.hp-invite {
  border-top: 1px solid var(--hp-join-border); padding-top: .5rem;
  --hp-invite-warn-bg: #fef3c7; --hp-invite-warn-fg: #78350f;
}
.hp-join-compact .hp-invite { font-size: .9rem; }
.hp-invite-toggle { cursor: pointer; font-weight: 600; padding: .35rem 0; }
.hp-invite-body { display: flex; flex-direction: column; gap: .55rem; padding-top: .4rem; }
.hp-invite-roles { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .3rem 1rem; }
.hp-invite-legend { font-weight: 500; padding: 0; margin-bottom: .2rem; }
.hp-invite-role { display: inline-flex; align-items: center; gap: .35rem; min-height: 2rem; cursor: pointer; }
.hp-invite-role-input { width: 1.1rem; height: 1.1rem; margin: 0; accent-color: var(--hp-join-accent); }
.hp-invite-warning {
  padding: .55rem .75rem; border-radius: 6px; font-size: .9em;
  background: var(--hp-invite-warn-bg); color: var(--hp-invite-warn-fg);
  border-left: 3px solid var(--hp-join-danger);
}
.hp-invite-expiry {
  font: inherit; font-size: .95em; padding: .4rem .5rem; border-radius: 6px;
  border: 1px solid var(--hp-join-border); background: var(--hp-join-bg); color: var(--hp-join-fg);
}
.hp-invite-create-admin { background: var(--hp-join-danger); border-color: var(--hp-join-danger); }
.hp-invite-result { display: flex; flex-direction: column; gap: .45rem; }
.hp-invite-note { font-size: .9em; color: var(--hp-join-muted); }
.hp-invite-qr { width: 100%; max-width: 15rem; align-self: center; }
.hp-invite-qr svg { display: block; width: 100%; height: auto; }
.hp-invite-link { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8em; }
.hp-invite-copied { font-size: .85em; color: var(--hp-join-live); }
.hp-invite-pending { display: flex; flex-direction: column; gap: .3rem; font-size: .9em; }
.hp-invite-pending-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.hp-invite-pending-title { font-weight: 500; }
.hp-invite-refresh { font-size: .85em; padding: .2rem .55rem; }
.hp-invite-pending-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
.hp-invite-pending-empty { color: var(--hp-join-muted); }
.hp-invite-tag {
  display: inline-block; padding: 0 .4rem; border-radius: 999px; font-size: .85em;
  border: 1px solid var(--hp-join-border);
}
.hp-invite-tag-admin { color: var(--hp-join-danger); border-color: var(--hp-join-danger); }
.hp-invite-when { color: var(--hp-join-muted); }
@media (max-width: 30rem) {
  /* On a phone the header's menu may sit mid-row; anchored to its button it
     would run off the screen's left edge. It becomes a sheet along the bottom
     instead, short enough to leave the header -- and the toggle that closes
     it -- in view. */
  .hp-join-menu-panel {
    position: fixed; left: .5rem; right: .5rem; top: auto; bottom: .5rem; width: auto;
    max-width: none; max-height: 70vh; box-shadow: 0 -4px 24px rgb(0 0 0 / .18);
  }
  .hp-join-button, .hp-invite-expiry { min-height: 2.5rem; }
  .hp-invite-share, .hp-invite-copy, .hp-invite-create { flex: 1 1 auto; }
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
