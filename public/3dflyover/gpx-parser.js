/* ─── Shared browser-side GPX parser ───────────────────────────────────────
   ONE parser for the whole app. The route-upload flow (index.html) and the 3D
   flyover (3dflyover.js) used to walk the file with two different pieces of
   code, so the same GPX could be accepted by one and rejected by the other
   (e.g. <rtept>-only route files, or heart rate in <extensions>). Both now call
   parseGpxPoints() and get identical points, elevation, timestamps, HR, cadence.

   Server-side validation (lib/routes.js) is intentionally separate: Node has no
   DOMParser, so it validates the upload with a streaming regex instead.
   ------------------------------------------------------------------------- */
const MAX_POINTS = 250000;
const HR_NAMES  = ['hr', 'heart_rate', 'heartRate', 'HeartRate'];
const CAD_NAMES = ['cad', 'cadence', 'Cadence'];

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Heart rate / cadence live in <extensions> (<gpxtpx:hr>, <ns3:hr>, …). Matching
// on localName makes the namespace prefix irrelevant.
function extNumber(node, names) {
  if (!node) return null;
  const kids = node.getElementsByTagName('*');
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    if (!names.includes(el.localName)) continue;
    const v = Number(String(el.textContent || '').trim());
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * @param {string} gpxStr   Raw GPX XML
 * @param {object} [opts]   { maxPoints }
 * @returns {{points: Array<{lat:number,lon:number,ele:number|null,time:string,hr:number|null,cad:number|null}>, kind:string}}
 */
export function parseGpxPoints(gpxStr, opts = {}) {
  const maxPoints = Number(opts && opts.maxPoints) || MAX_POINTS;
  // Uploads are strict (a bad coordinate is a validation error). The 3D preview
  // uses skipInvalid so one stray point can never make a file unloadable.
  const skipInvalid = !!(opts && opts.skipInvalid);
  const doc = new DOMParser().parseFromString(String(gpxStr || ''), 'application/xml');
  const errEl = doc.querySelector('parsererror');
  if (errEl) throw new Error('Invalid GPX file: ' + String(errEl.textContent || '').slice(0, 80));

  // Track points first; route files often only have <rtept> / <wpt>.
  let nodes = [...doc.querySelectorAll('trkpt')];
  if (!nodes.length) nodes = [...doc.querySelectorAll('rtept')];
  if (!nodes.length) nodes = [...doc.querySelectorAll('wpt')];
  if (!nodes.length) throw new Error('No track, route, or waypoint points found in GPX file');
  if (nodes.length > maxPoints) {
    throw new Error('GPX contains too many route points (maximum ' + maxPoints.toLocaleString() + ')');
  }

  const points = [];
  for (const n of nodes) {
    const lat = toNum(n.getAttribute('lat'));
    const lon = toNum(n.getAttribute('lon'));
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      if (!skipInvalid) throw new Error('GPX contains an invalid latitude/longitude');
      continue;
    }
    let ele = null;
    const eleEl = n.querySelector('ele');
    if (eleEl) {
      const raw = String(eleEl.textContent || '').trim();
      if (raw !== '') {
        const e = toNum(raw);
        if (e === null) throw new Error('GPX contains an invalid elevation value');
        ele = e;
      }
    }
    const timeEl = n.querySelector('time');
    points.push({
      lat, lon, ele,
      time: timeEl ? String(timeEl.textContent || '').trim() : '',
      hr: extNumber(n, HR_NAMES),
      cad: extNumber(n, CAD_NAMES)
    });
  }
  if (points.length < 2) throw new Error('GPX has fewer than 2 valid track points');
  return { points, kind: String((nodes[0] && nodes[0].nodeName) || '').toLowerCase() };
}

export default parseGpxPoints;
