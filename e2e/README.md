# e2e/ (not yet implemented)

Placeholder for a Freighter-extension browser harness (e.g. Playwright with
the Freighter extension side-loaded) that click-through tests `app/` for
real, the way the `vite build`-succeeds-but-`global`-is-undefined bug in
`app/vite.config.js` was actually caught in the original build. `node --check`
and `vite build` both pass even when that polyfill is missing — see the
comment in `vite.config.js` — so a real headless-browser run is the only
thing that would catch a regression here. Tracked as a Phase 7 hardening
item (see root README) rather than built now, since it needs a browser
automation stack this environment doesn't have installed.
