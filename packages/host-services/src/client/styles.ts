/**
 * The client bundle's stylesheet, injected once as a single <style> tag by
 * apply(). Class names are hand-prefixed (`dshc-`) instead of CSS modules -
 * the DSH build preset's css-modules pipeline is not available here, and a
 * plain tag keeps the bundle self-contained. Every color/background/border
 * binds to the DSH design-system variables (`--dsw-alias-*`), so the surfaces
 * follow the user's light/dark theme exactly like the native pages. The last
 * block re-labels the sidebar brand row: DSH css-module classes are
 * `<hash>_<local>`, so the attribute selectors survive hash churn while
 * staying scoped to the brand cell (best-effort by design; see README
 * known-key-points).
 */

export const CLIENT_CSS = `
.dshc-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: var(--dsw-mask-blur, rgba(0,0,0,.45)); }
.dshc-modal-card { width: min(480px, calc(100vw - 48px)); max-height: calc(100vh - 64px); overflow: auto; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 22px 24px; box-shadow: 0 12px 40px rgba(0,0,0,.25); font-family: inherit; }
.dshc-modal-card h2 { margin: 0 0 6px; font-size: 16px; color: var(--dsw-alias-label-primary); }
.dshc-modal-card p.dshc-sub { margin: 0 0 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-field { margin: 0 0 12px; }
.dshc-field > label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 5px; }
.dshc-input, .dshc-select { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
.dshc-input:focus, .dshc-select:focus { outline: 1px solid var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dshc-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshc-row > .dshc-input, .dshc-row > .dshc-select { flex: 1; min-width: 0; }
.dshc-btn { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border: 0; border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; white-space: nowrap; }
.dshc-btn:hover { background: var(--dsw-alias-button-primary-hover); }
.dshc-btn:disabled { opacity: .55; cursor: default; }
.dshc-btn.ghost { background: transparent; color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-brand-primary); }
.dshc-btn.ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-btn.link { background: transparent; color: var(--dsw-alias-brand-primary); border: 0; padding: 7px 4px; text-decoration: underline; }
.dshc-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.dshc-error { margin: 8px 0 0; font-size: 12px; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-all; }
.dshc-hint { margin: 6px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dshc-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 14px 16px; margin: 0 0 12px; color: var(--dsw-alias-label-primary); }
.dshc-card h3 { margin: 0 0 4px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshc-card .dshc-desc { margin: 0 0 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dshc-switch { position: relative; width: 34px; height: 19px; border-radius: 999px; border: 0; cursor: pointer; background: var(--dsw-alias-border-l3); transition: background .15s; flex: none; }
.dshc-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: left .15s; }
.dshc-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dshc-switch[aria-checked='true']::after { left: 17px; background: var(--dsw-alias-label-primary-foreground); }
.dshc-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-status.ok { color: var(--dsw-alias-state-success-primary); }
.dshc-status.bad { color: var(--dsw-alias-state-error-primary); }
.dshc-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; overflow: hidden; }
.dshc-seg button { background: transparent; color: var(--dsw-alias-label-secondary); border: 0; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.dshc-seg button.on { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dshc-model-filter { margin: 0 0 6px; }
.dshc-empty { padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dshc-badge { display: inline-block; font-size: 10px; color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-brand-primary); border-radius: 4px; padding: 1px 6px; margin-left: 6px; vertical-align: 1px; }
.dshc-banner { background: var(--dsw-alias-state-warn-label, #6b5a1e); color: var(--dsw-alias-label-primary-foreground, #fff); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px 12px; font-size: 12px; margin: 0 0 12px; }
.dshc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 0; flex: none; }
.dshc-dot.ok { background: var(--dsw-alias-state-success-primary); }
.dshc-dot.bad { background: var(--dsw-alias-state-error-primary); }
.dshc-dot.unknown { background: var(--dsw-alias-label-tertiary); }
.dshc-list { list-style: none; margin: 0; padding: 0; }
.dshc-list > li { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; margin: 0 0 8px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshc-list .dshc-list-main { flex: 1; min-width: 0; }
.dshc-list .dshc-list-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; word-break: break-all; }
.dshc-btn.danger { background: transparent; color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); }
.dshc-btn.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dshc-btn.small { padding: 4px 10px; font-size: 12px; }
.dshc-section-title { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .5px; }
/* Sidebar brand row re-label (hash-stable best-effort; see module doc). */
[class*='_brand'][class*='_wide'] svg { display: none; }
[class*='_brand'][class*='_wide']::after { content: 'DSH Cline'; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); letter-spacing: .2px; }
/* Resizable-window adaptation: stack rows that would overflow a narrow panel,
   and let segmented controls wrap instead of clipping. */
@media (max-width: 480px) {
  .dshc-row { flex-wrap: wrap; }
  .dshc-actions { flex-wrap: wrap; gap: 6px; }
  .dshc-btn { white-space: normal; }
  .dshc-seg { flex-wrap: wrap; }
  .dshc-modal-card { padding: 16px; }
  .dshc-modal-card h2 { font-size: 15px; }
  .dshc-list > li { flex-wrap: wrap; }
  .dshc-card { padding: 12px; }
}
`
