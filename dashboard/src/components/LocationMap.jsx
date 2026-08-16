import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const BRAND = '#4f46e5'; // brand-600

// CARTO basemaps: permissive usage policy (OpenStreetMap's own tile server
// serves "Access blocked" tiles for embedded / no-Referer use) and native
// light/dark styles that match the console theme without a CSS invert hack.
const cartoUrl = (dark) =>
  `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`;
const isDarkTheme = () => document.documentElement.classList.contains('dark');

/**
 * Live device-location panel. Leaflet + OpenStreetMap tiles are bundled locally
 * (no CDN). Street tiles need internet; when offline the marker + accuracy ring
 * still render over the grid background and the coordinates are always shown, so
 * the panel stays useful on an air-gapped / hotspot demo network.
 */
export default function LocationMap({ latitude, longitude }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const ringRef = useRef(null);
  const tileRef = useRef(null);

  const hasLoc = typeof latitude === 'number' && typeof longitude === 'number';

  useEffect(() => {
    if (!hasLoc || !elRef.current) return;
    if (!mapRef.current) {
      const map = L.map(elRef.current, {
        center: [latitude, longitude],
        zoom: 15,
        zoomControl: true,
        scrollWheelZoom: false,
        attributionControl: true,
      });
      tileRef.current = L.tileLayer(cartoUrl(isDarkTheme()), {
        subdomains: 'abcd',
        maxZoom: 20,
        crossOrigin: true,
        attribution: '© OpenStreetMap contributors, © CARTO',
      }).addTo(map);
      ringRef.current = L.circle([latitude, longitude], {
        radius: 75, color: BRAND, weight: 1, fillColor: BRAND, fillOpacity: 0.12,
      }).addTo(map);
      markerRef.current = L.circleMarker([latitude, longitude], {
        radius: 7, color: '#ffffff', weight: 2.5, fillColor: BRAND, fillOpacity: 1,
      }).addTo(map);
      mapRef.current = map;
    } else {
      mapRef.current.setView([latitude, longitude], mapRef.current.getZoom(), { animate: true });
      markerRef.current.setLatLng([latitude, longitude]);
      ringRef.current.setLatLng([latitude, longitude]);
    }
    // Leaflet mis-sizes if the container laid out after init (flex/grid); nudge it.
    const t = setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 120);
    return () => clearTimeout(t);
  }, [latitude, longitude, hasLoc]);

  useEffect(
    () => () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    },
    [],
  );

  // Recolor the basemap (dark_all <-> light_all) when the console theme toggles.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      if (tileRef.current) tileRef.current.setUrl(cartoUrl(isDarkTheme()));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  if (!hasLoc) {
    return (
      <div className="location-map-empty grid place-items-center text-center px-6 h-full min-h-[240px]">
        <div className="space-y-2">
          <svg viewBox="0 0 24 24" className="h-8 w-8 mx-auto text-slate-400 dark:text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7-5.686-7-11a7 7 0 0114 0c0 5.314-7 11-7 11z" />
            <circle cx="12" cy="10" r="2.5" />
          </svg>
          <div className="text-sm text-slate-500 dark:text-slate-400">No location yet</div>
          <div className="text-xs text-slate-400 dark:text-slate-500 max-w-[16rem] mx-auto">
            Run <span className="font-semibold">Locate</span> above. The device must have location turned on — the agent
            reports its position on the next check-in.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[240px]">
      <div ref={elRef} className="location-map absolute inset-0" />
      <div className="absolute bottom-2 left-2 z-[1000] rounded-md bg-white/85 dark:bg-slate-900/85 backdrop-blur px-2.5 py-1.5 text-xs shadow ring-1 ring-slate-200 dark:ring-slate-700">
        <div className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
          {latitude.toFixed(5)}, {longitude.toFixed(5)}
        </div>
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`}
          target="_blank"
          rel="noreferrer"
          className="text-brand-700 dark:text-brand-300 hover:text-brand-800 inline-flex items-center gap-1 mt-0.5"
        >
          Open in Google Maps
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
          </svg>
        </a>
      </div>
    </div>
  );
}
