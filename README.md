# Waypoint 🥾

A free, open-source "AllTrails-lite." Find hiking trails near you, see them on a
map, and — the key bit — **see where you are on the trail live via GPS**.

No account, no subscription, no API keys. All data is open:

| Need     | Source                          | Cost |
|----------|---------------------------------|------|
| Trails   | OpenStreetMap (Overpass API)    | Free |
| Basemap  | OpenStreetMap tiles             | Free |
| Weather  | Open-Meteo                      | Free |
| GPS      | Browser Geolocation API         | Free |

## Try it

Because GPS needs HTTPS, open the **GitHub Pages URL** on your phone (see repo
Settings → Pages). Or run locally:

```bash
cd waypoint
python3 -m http.server 8000   # then open http://localhost:8000
```

`localhost` counts as a secure context, so GPS works there too.

Then: tap the **crosshair** to locate yourself → **Find trails near here** →
tap a trail → start walking. The card tells you how far along you are.

## How it works (the 60-second tour)

- `index.html` — layout: the map, a locate button, and a bottom sheet.
- `js/overpass.js` — **data layer.** Pure functions that fetch trails from
  OpenStreetMap, measure their length (haversine), and rate difficulty.
  Runs in Node too, so it's testable: `node test.js`.
- `js/app.js` — **controller.** Draws the map, tracks your GPS with
  `watchPosition`, and snaps your position onto the nearest trail to compute
  "you are 42% along."
- `sw.js` + `manifest.webmanifest` — makes it an installable, offline-capable PWA.

## Roadmap

- [ ] Real elevation profiles (Open-Elevation / OpenTopoData)
- [ ] Off-route alert ("you've wandered 80 m off the trail")
- [ ] Pre-download tiles for a park (true offline hiking)
- [ ] Save favorites / recent trails
- [ ] Weekend suggestions feed with weather (already prototyped)

## License

MIT. Trail data © OpenStreetMap contributors (ODbL).
