/**
 * Legend entries for the map viewer (PRD 10.6): from the MapServer legend endpoint, or, when that is
 * missing (FeatureServer), from the layer's drawingInfo renderer.
 */

export interface LegendEntry {
  label: string;
  /** CSS colour of the swatch fill (or line / point colour). */
  color?: string;
  outline?: string;
  /** data: URL for picture symbols. */
  image?: string;
  shape: 'fill' | 'line' | 'point';
}

const rgba = (c: unknown): string | undefined => {
  if (!Array.isArray(c) || c.length < 3) return undefined;
  const [r, g, b, a = 255] = c as number[];
  return `rgba(${r},${g},${b},${Math.round((a / 255) * 100) / 100})`;
};

/** CIM colours are ["CIMRGBColor", {values:[r,g,b,alpha 0-100]}] or {type:'CIMRGBColor', values:[...]}. */
const cimColor = (c: any): string | undefined => {
  const v = c?.values ?? (Array.isArray(c) ? c[1]?.values : undefined);
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const a = v.length > 3 ? v[3] / 100 : 1;
  return `rgba(${v[0]},${v[1]},${v[2]},${Math.round(a * 100) / 100})`;
};

function fromCim(symbol: any): Pick<LegendEntry, 'color' | 'outline' | 'shape'> {
  const layers: any[] = symbol?.symbol?.symbolLayers ?? symbol?.symbolLayers ?? [];
  const fill = layers.find((l) => l.type === 'CIMSolidFill');
  const stroke = layers.find((l) => l.type === 'CIMSolidStroke');
  const geom = symbol?.symbol?.type ?? symbol?.type ?? '';
  const shape: LegendEntry['shape'] = /Line/i.test(geom) ? 'line' : /Point/i.test(geom) ? 'point' : 'fill';
  return { color: cimColor(fill?.color) ?? cimColor(stroke?.color), outline: cimColor(stroke?.color), shape };
}

export function symbolToEntry(symbol: any, label: string): LegendEntry {
  if (!symbol) return { label, shape: 'fill' };
  const t: string = symbol.type ?? '';
  if (t === 'esriPMS' || t === 'esriPFS') {
    if (symbol.imageData) return { label, shape: t === 'esriPFS' ? 'fill' : 'point', image: `data:${symbol.contentType ?? 'image/png'};base64,${symbol.imageData}` };
  }
  if (t === 'esriSLS') return { label, shape: 'line', color: rgba(symbol.color) };
  if (t === 'esriSMS') return { label, shape: 'point', color: rgba(symbol.color), outline: rgba(symbol.outline?.color) };
  if (t === 'esriSFS') return { label, shape: 'fill', color: rgba(symbol.color), outline: rgba(symbol.outline?.color) };
  if (t.startsWith('CIM') || symbol.symbol?.type?.startsWith?.('CIM')) return { label, ...fromCim(symbol) };
  return { label, shape: 'fill', color: rgba(symbol.color) };
}

/** drawingInfo.renderer -> entries. Handles simple, uniqueValue and classBreaks renderers. */
export function rendererToLegend(renderer: any): LegendEntry[] {
  if (!renderer || typeof renderer !== 'object') return [];
  switch (renderer.type) {
    case 'simple':
      return [symbolToEntry(renderer.symbol, renderer.label || renderer.description || 'All features')];
    case 'uniqueValue': {
      const out = (renderer.uniqueValueInfos ?? renderer.uniqueValueGroups?.flatMap((g: any) => g.classes ?? []) ?? []).map((u: any) =>
        symbolToEntry(u.symbol, String(u.label ?? u.value ?? '')),
      ) as LegendEntry[];
      if (renderer.defaultSymbol) out.push(symbolToEntry(renderer.defaultSymbol, renderer.defaultLabel || 'Other'));
      return out;
    }
    case 'classBreaks': {
      const out = (renderer.classBreakInfos ?? []).map((c: any) => symbolToEntry(c.symbol, String(c.label ?? c.classMaxValue ?? ''))) as LegendEntry[];
      if (renderer.defaultSymbol) out.push(symbolToEntry(renderer.defaultSymbol, renderer.defaultLabel || 'Other'));
      return out;
    }
    default:
      return [];
  }
}

/** `/MapServer/legend?f=json` -> entries for one layer. */
export function mapServerLegend(json: any, layerId: number): LegendEntry[] {
  const layer = (json?.layers ?? []).find((l: any) => Number(l.layerId) === layerId);
  return (layer?.legend ?? []).map((l: any) => ({
    label: String(l.label ?? ''),
    shape: 'fill' as const,
    image: l.imageData ? `data:${l.contentType ?? 'image/png'};base64,${l.imageData}` : undefined,
  }));
}

/**
 * Service extent -> [[south, west], [north, east]] in WGS84, for the SRs that convert without a server.
 * Returns null otherwise (the viewer then asks the server for the extent in WGS84).
 */
export function extentToLatLngBounds(extent: any): [[number, number], [number, number]] | null {
  if (!extent || ![extent.xmin, extent.ymin, extent.xmax, extent.ymax].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  const merc = (x: number, y: number): [number, number] => [(Math.atan(Math.sinh(y / 6378137)) * 180) / Math.PI, (x / 6378137) * (180 / Math.PI)];
  if (wkid === 4326) return [[extent.ymin, extent.xmin], [extent.ymax, extent.xmax]];
  if ([102100, 3857, 102113, 3785].includes(wkid)) {
    const sw = merc(extent.xmin, extent.ymin);
    const ne = merc(extent.xmax, extent.ymax);
    return [sw, ne];
  }
  return null;
}
