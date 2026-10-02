/**
 * A floating sidebar handle for phone-sized viewports.
 *
 * Why this exists (2026-10-02, measured): with dsh-mobile-compat@0.5.0 active, the
 * sidebar column is translated fully off-canvas (x = -393 on a 393px viewport) — which
 * is what we want — but the shipped reopen control travels WITH it: the frame's
 * `shell.leading` occupant measured at x = -383, i.e. off-screen. On a phone the sidebar
 * could therefore be opened by no visible control at all.
 *
 * Why `shell.overlay` and not `shell.leading`: `shell.leading` is a single-occupant seat
 * owned by ui-sidebar (`replaceRisk: shadows-shipped-ui`), so taking it would replace the
 * shipped controls and lose the New Session button. `shell.overlay` is the additive,
 * `replaceRisk: none` list seat — a fresh id is placed beside the shipped entries. Its
 * layer is click-through, so this button opts back into pointer events explicitly.
 *
 * Placement deliberately does not read any other plugin's DOM or stylesheet (the plugin
 * authoring rules forbid it): the button pins itself to the viewport's top-left corner
 * with the safe-area inset, which is where a phone app puts this control.
 *
 * Colors come from theme alias tokens only, so light and dark both follow the host.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mobile-sidebar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const HANDLE_CLASS = 'dsh-mobile-sidebar-handle';

    // The surface color is the overlay/popover alias, which is already the theme's
    // translucent raised surface. color-mix is used only to state the translucency
    // explicitly where the engine supports it; the plain token is the fallback.
    const CSS = `
.${HANDLE_CLASS} {
  position: fixed;
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  top: calc(env(safe-area-inset-top, 0px) + 10px);
  z-index: 24;
  display: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  backdrop-filter: blur(14px) saturate(160%);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 4px 14px rgba(0, 0, 0, 0.10);
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 140ms ease, transform 140ms ease;
}
@supports (color: color-mix(in srgb, red 50%, transparent)) {
  .${HANDLE_CLASS} {
    background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 78%, transparent);
  }
}
.${HANDLE_CLASS}:active { transform: scale(0.94); }
.${HANDLE_CLASS}:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, currentColor);
  outline-offset: 2px;
}
@media (hover: hover) {
  .${HANDLE_CLASS}:hover { background: var(--dsw-alias-button-floating-hover, var(--dsw-alias-bg-layer-2)); }
}
/* Phone-shaped viewports, and any coarse pointer (tablets, landscape phones). */
@media (max-width: 720px), (pointer: coarse) {
  .${HANDLE_CLASS} { display: inline-flex; }
}
@media (prefers-reduced-motion: reduce) {
  .${HANDLE_CLASS} { transition: none; }
}
`;

    /** Panel-left glyph, drawn inline: a Client half must not import ui-primitives. */
    function PanelLeftGlyph() {
      return h('svg', {
        width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, focusable: false,
      },
        h('rect', {
          x: 3.25, y: 4.25, width: 17.5, height: 15.5, rx: 3.25,
          stroke: 'currentColor', strokeWidth: 1.5,
        }),
        h('line', {
          x1: 9.5, y1: 4.25, x2: 9.5, y2: 19.75,
          stroke: 'currentColor', strokeWidth: 1.5,
        }));
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        // Reuse the shipped sidebar namespace so the accessible name matches the
        // desktop control and follows the active locale; fall back to a literal if
        // that namespace is not registered in this deployment.
        let label = '打开侧边栏';
        try {
          const t = ctx.locale.bind('sidebar');
          const localized = t('toggle.open');
          if (typeof localized === 'string' && localized !== '') label = localized;
        } catch { /* keep the literal */ }

        function MobileSidebarHandle() {
          return h('button', {
            type: 'button',
            className: HANDLE_CLASS,
            'aria-label': label,
            onClick: () => { ctx.layout.toggleSidebar(); },
          }, h(PanelLeftGlyph, null));
        }

        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-plugin', '@local/dsh-mobile-sidebar');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => { style.remove(); };
        });

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'mobile-sidebar-handle',
          order: 40,
        }, MobileSidebarHandle));
      },
    };
  },
});
