/*
 * config.js — runtime configuration for Waypoint.
 *
 * WAYPOINT_API_BASE controls where the data layer sends trail/geocode/elevation
 * requests:
 *   - ''  (empty, the default) -> "direct mode": the browser calls the public
 *          OpenStreetMap / Open-Meteo services directly, exactly as before. This
 *          keeps the static GitHub Pages build working with no backend.
 *   - a URL like 'https://waypoint-backend.fly.dev' -> route everything through
 *          our own caching/geofenced/rate-limited backend proxy instead. Point
 *          this at the deployed backend (no trailing slash) to go live.
 *
 * This is deliberately a plain global (not a build step) so the same static
 * bundle can be flipped by editing one line, or overridden at deploy time.
 */
window.WAYPOINT_API_BASE = '';
