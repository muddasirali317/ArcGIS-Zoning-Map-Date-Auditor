/**
 * Interactive map for the selected row (PRD 10.6). The map is created when a row is selected and
 * destroyed when the selection changes, so 1,000 rows never mean 1,000 live maps.
 * The browser talks to the city's server directly, so with a geo-blocked city the browser VPN applies.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as EsriLeaflet from 'esri-leaflet';
import 'esri-leaflet-renderers';
import { extentToLatLngBounds, mapServerLegend, normalizeUrl, rendererToLegend, zoningScore, type CheckResult, type CheckRow, type LegendEntry, type RawConfig } from '@zoning/core';

interface LayerInfo {
  id: number;
  name: string;
  visible: boolean;
}

interface LegendGroup {
  layerId: number;
  name: string;
  entries: LegendEntry[];
}

const BASEMAPS = {
  streets: { label: 'Streets', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
  dark: { label: 'Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', attribution: '© OpenStreetMap, © CARTO' },
  light: { label: 'Light grey', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', attribution: '© OpenStreetMap, © CARTO' },
  none: { label: 'No basemap', url: '', attribution: '' },
} as const;
type BasemapKey = keyof typeof BASEMAPS;

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetch(url, { signal: AbortSignal.any([signal, timeout]), credentials: 'omit' });
  const json = await res.json();
  if (json?.error) throw new Error(json.error.code === 499 || json.error.code === 498 ? 'This service is private (login required).' : json.error.message || `ArcGIS error ${json.error.code}`);
  return json;
}

/** Floating map panels start collapsed (they cover the map) and remember how the analyst left them. */
function usePanelState(name: string): [boolean, (f: (o: boolean) => boolean) => void] {
  const key = `zoning-auditor:${name}`;
  const [open, set] = useState(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  return [open, (f) => set((o) => {
    const n = f(o);
    try { localStorage.setItem(key, n ? '1' : '0'); } catch { /* not remembered */ }
    return n;
  })];
}

export function MapViewer(props: { row: CheckRow; result?: CheckResult; config: RawConfig | null; onRenderFailed(id: string, message: string): void }) {
  const { row, result, config } = props;
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseRef = useRef<L.TileLayer | null>(null);
  const boundsRef = useRef<L.LatLngBoundsExpression | null>(null);
  const layerJsonRef = useRef(new Map<number, any>());
  const legendJsonRef = useRef<any | null | undefined>(undefined);
  const overlaysRef = useRef<{ dynamic?: any; image?: any; features: Map<number, any> }>({ features: new Map() });

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [legend, setLegend] = useState<LegendGroup[]>([]);
  const [basemap, setBasemap] = useState<BasemapKey>('streets');
  const [opacity, setOpacity] = useState(0.8);
  const [kind, setKind] = useState('');
  // For a viewer / app link, draw the map service the check found behind it.
  const mapUrl = result?.normalizedUrl && result.resolvedFrom ? result.normalizedUrl : row.url;
  const norm = useMemo(() => normalizeUrl(mapUrl), [mapUrl]);
  const serviceUrl = norm.ok ? norm.serviceUrl : '';
  const reported = useRef(false);

  // ---- create / destroy the map for this row ------------------------------
  useEffect(() => {
    setStatus('loading');
    setError('');
    setLayers([]);
    setLegend([]);
    reported.current = false;
    layerJsonRef.current = new Map();
    legendJsonRef.current = undefined;
    overlaysRef.current = { features: new Map() };
    boundsRef.current = null;

    if (!norm.ok || !['MapServer', 'FeatureServer', 'ImageServer'].includes(norm.kind)) {
      setStatus('error');
      setError(norm.ok ? 'This link is not a map service the viewer can draw.' : norm.reason);
      return;
    }
    const ctrl = new AbortController();
    const map = L.map(mapDiv.current!, { zoomControl: true }).setView([39.5, -98.35], 4);
    mapRef.current = map;
    setKind(norm.kind);

    const fail = (message: string) => {
      if (ctrl.signal.aborted) return;
      setError(message);
      setStatus('error');
      if (!reported.current) {
        reported.current = true;
        props.onRenderFailed(row.id, message);
      }
    };

    (async () => {
      try {
        const root = await getJson(`${norm.serviceUrl}?f=json`, ctrl.signal);
        let infos: LayerInfo[];
        if (norm.layerId !== undefined) {
          infos = [{ id: norm.layerId, name: (root.layers ?? []).find((l: any) => l.id === norm.layerId)?.name ?? `Layer ${norm.layerId}`, visible: true }];
        } else if (norm.kind === 'ImageServer') {
          infos = [];
        } else {
          const all = (root.layers ?? []).filter((l: any) => !(Array.isArray(l.subLayerIds) && l.subLayerIds.length));
          const keywords = config?.layerKeywords ?? ['zoning', 'zone', 'district'];
          const zoning = all.filter((l: any) => l.name === result?.zoningLayerName || zoningScore(String(l.name), keywords) > 0);
          // Show the zoning layer(s); with none recognisable, the layers the service shows by default (at most 3).
          const shown = new Set((zoning.length ? zoning : all.filter((l: any) => l.defaultVisibility !== false).slice(0, 3)).map((l: any) => l.id));
          infos = all.map((l: any) => ({ id: Number(l.id), name: String(l.name), visible: shown.has(l.id) }));
        }
        if (ctrl.signal.aborted) return;
        setLayers(infos);

        let bounds = extentToLatLngBounds(root.fullExtent ?? root.initialExtent);
        if (!bounds) {
          // Other projections: ask the server for the extent already in WGS84.
          const first = infos.find((i) => i.visible) ?? infos[0];
          if (first) {
            try {
              const q = await getJson(`${norm.serviceUrl}/${first.id}/query?where=1%3D1&returnExtentOnly=true&outSR=4326&f=json`, ctrl.signal);
              bounds = extentToLatLngBounds({ ...q.extent, spatialReference: { wkid: 4326 } });
            } catch {
              /* keep the default view */
            }
          }
        }
        if (ctrl.signal.aborted) return;
        if (bounds) {
          boundsRef.current = bounds;
          map.fitBounds(bounds);
        }
        setStatus('ready');
      } catch (e) {
        fail(`The map could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      ctrl.abort();
      map.remove();
      mapRef.current = null;
      baseRef.current = null;
    };
    // The map is rebuilt only when a different row (or its link) is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, mapUrl]);

  // ---- basemap ------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    baseRef.current?.remove();
    baseRef.current = null;
    const b = BASEMAPS[basemap];
    if (b.url) {
      baseRef.current = L.tileLayer(b.url, { attribution: b.attribution, maxZoom: 19 }).addTo(map);
      baseRef.current.bringToBack();
    }
  }, [basemap, status]);

  // ---- overlays follow the visibility checkboxes ---------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status === 'loading' || !norm.ok) return;
    const visible = layers.filter((l) => l.visible).map((l) => l.id);
    const o = overlaysRef.current;
    const onError = (e: any) => {
      const msg = `The server did not return map data (${e?.message ?? e?.code ?? 'request failed'}).`;
      setError(msg);
      if (!reported.current) {
        reported.current = true;
        props.onRenderFailed(row.id, msg);
      }
    };
    if (norm.kind === 'MapServer') {
      if (visible.length === 0) {
        o.dynamic?.remove();
      } else if (!o.dynamic) {
        o.dynamic = (EsriLeaflet as any).dynamicMapLayer({ url: norm.serviceUrl, layers: visible, opacity: 1 }).addTo(map);
        o.dynamic.on('requesterror', onError);
      } else {
        o.dynamic.setLayers(visible);
        if (!map.hasLayer(o.dynamic)) o.dynamic.addTo(map);
      }
    } else if (norm.kind === 'FeatureServer') {
      for (const l of layers) {
        const existing = o.features.get(l.id);
        if (l.visible && !existing) {
          const fl = (EsriLeaflet as any).featureLayer({ url: `${norm.serviceUrl}/${l.id}`, simplifyFactor: 0.5, precision: 5 }).addTo(map);
          fl.on('requesterror', onError);
          o.features.set(l.id, fl);
        } else if (l.visible && existing && !map.hasLayer(existing)) existing.addTo(map);
        else if (!l.visible && existing && map.hasLayer(existing)) existing.remove();
      }
    } else if (norm.kind === 'ImageServer' && !o.image) {
      o.image = (EsriLeaflet as any).imageMapLayer({ url: norm.serviceUrl }).addTo(map);
      o.image.on('requesterror', onError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, status]);

  // ---- opacity applies to every overlay at once ----------------------------
  useEffect(() => {
    const pane = mapRef.current?.getPane('overlayPane');
    if (pane) pane.style.opacity = String(opacity);
  }, [opacity, status]);

  // ---- legend for the visible layers ---------------------------------------
  useEffect(() => {
    if (status !== 'ready' || !norm.ok || (norm.kind !== 'MapServer' && norm.kind !== 'FeatureServer')) return;
    const ctrl = new AbortController();
    const visible = layers.filter((l) => l.visible);
    (async () => {
      if (norm.kind === 'MapServer' && legendJsonRef.current === undefined) {
        legendJsonRef.current = await getJson(`${norm.serviceUrl}/legend?f=json`, ctrl.signal).catch(() => null);
      }
      const groups: LegendGroup[] = [];
      for (const l of visible) {
        let entries = norm.kind === 'MapServer' && legendJsonRef.current ? mapServerLegend(legendJsonRef.current, l.id) : [];
        if (entries.length === 0) {
          // No legend endpoint (or no entries): fall back to the layer's own renderer.
          if (!layerJsonRef.current.has(l.id)) layerJsonRef.current.set(l.id, await getJson(`${norm.serviceUrl}/${l.id}?f=json`, ctrl.signal).catch(() => null));
          entries = rendererToLegend(layerJsonRef.current.get(l.id)?.drawingInfo?.renderer);
        }
        groups.push({ layerId: l.id, name: l.name, entries });
      }
      if (!ctrl.signal.aborted) setLegend(groups);
    })().catch(() => undefined);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, status]);

  const toggle = (id: number) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));

  const [toolsOpen, setToolsOpen] = usePanelState('map-tools');
  const [legendOpen, setLegendOpen] = usePanelState('map-legend');
  const legendCount = legend.reduce((n, g) => n + g.entries.length, 0);
  const shownCount = layers.filter((l) => l.visible).length;

  return (
    <div className="viewer">
      <div ref={mapDiv} className="map" role="application" aria-label={`Map for ${row.city}`} />
      {status === 'loading' && <div className="map-msg">Loading map…</div>}
      {error && (
        <div className="map-error" role="alert">
          {error} Recorded as MAP_RENDER_FAILED on this row. If the city blocks non-US traffic, turn on your browser VPN and select the row again.
        </div>
      )}

      <div className={`map-float map-tools ${toolsOpen ? '' : 'closed'}`}>
        <button className="float-head" onClick={() => setToolsOpen((o) => !o)} aria-expanded={toolsOpen}>
          <span>Map tools</span><span aria-hidden="true">{toolsOpen ? '–' : '+'}</span>
        </button>
        {toolsOpen && (
          <div className="float-body">
            <label>Basemap
              <select value={basemap} onChange={(e) => setBasemap(e.target.value as BasemapKey)}>
                {Object.entries(BASEMAPS).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
              </select>
            </label>
            <label>Opacity
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Layer opacity" />
            </label>
            <div className="float-actions">
              <button className="small" onClick={() => boundsRef.current && mapRef.current?.fitBounds(boundsRef.current)} disabled={!boundsRef.current}>Zoom to extent</button>
              <a className="button small" href={norm.ok ? norm.serviceUrl : mapUrl} target="_blank" rel="noreferrer">Open endpoint</a>
            </div>
            {layers.length > 0 && kind !== 'ImageServer' && (
              <details className="layer-toggles" open={layers.length <= 6}>
                <summary>Layers ({shownCount} of {layers.length})</summary>
                <ul className="plain">
                  {layers.map((l) => (
                    <li key={l.id}>
                      <label><input type="checkbox" checked={l.visible} onChange={() => toggle(l.id)} /> {l.name} <span className="muted">#{l.id}</span></label>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      <div className={`map-float map-legend ${legendOpen ? '' : 'closed'}`}>
        <button className="float-head" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>
          <span>Legend{legendCount ? ` (${legendCount})` : ''}</span><span aria-hidden="true">{legendOpen ? '–' : '+'}</span>
        </button>
        {legendOpen && (
          <div className="float-body legend">
            {legend.length === 0 && <p className="muted small">{status === 'ready' ? 'No legend is available for the visible layers.' : '—'}</p>}
            {legend.map((g) => (
              <div key={g.layerId} className="legend-group">
                <strong>{g.name}</strong>
                {g.entries.length === 0 && <div className="muted small">No legend entries.</div>}
                <ul className="plain">
                  {g.entries.map((e, i) => (
                    <li key={i} className="legend-row">
                      {e.image ? (
                        <img src={e.image} alt="" width={18} height={18} />
                      ) : (
                        <span className={`swatch ${e.shape}`} style={{ background: e.shape === 'line' ? 'transparent' : e.color, borderColor: e.outline ?? e.color, borderTopColor: e.shape === 'line' ? e.color : undefined }} aria-hidden="true" />
                      )}
                      <span>{e.label || '(no label)'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
