/**
 * stravaPublic.js — Strava PUBLIC activity import without any credentials.
 *
 * Extracted from lib/strava.js so it has NO dependency on Google Sheets,
 * googleapis or Strava OAuth. That lets the local dev server (server.js) serve
 * "paste a public Strava link" imports with nothing configured.
 *
 * How it works:
 *   1. Resolve the pasted link (follows strava.app.link / short redirects).
 *   2. Fetch the public activity page HTML (or the public embed page).
 *   3. Pull the route geometry out of the embedded JSON (summary_polyline).
 *
 * Limitations: only PUBLIC activities, only the reduced-resolution
 * summary_polyline, and it depends on Strava's public markup.
 */

function extractActivityId(input, resolvedUrl = '') {
  const candidates = [input, resolvedUrl].filter(Boolean).map(String);
  for (const raw of candidates) {
    const m = raw.match(/(?:strava\.com\/(?:activities|activity)\/|strava\.app\.link\/[^/?#]+[/?#]?(?:.*?activity(?:Id|_id)?[=/])?)(\d{5,})/i);
    if (m) return m[1];
    const direct = raw.match(/\/activities\/(\d{5,})(?:[/?#]|$)/i);
    if (direct) return direct[1];
    const q = raw.match(/[?&](?:activity_id|activityId|id)=(\d{5,})/i);
    if (q) return q[1];
  }
  return '';
}

async function fetchRedirectTarget(rawUrl, maxHops = 5) {
  let current = rawUrl;
  const seen = new Set();
  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(current)) break;
    seen.add(current);
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
        }
      });
    } catch (err) {
      throw new Error(`Could not resolve the Strava share link. ${err?.message || ''}`.trim());
    }

    const location = response.headers.get('location');
    if (location) {
      const next = new URL(location, current).toString();
      const id = extractActivityId(current, next);
      if (id) return { activityId: id, resolvedUrl: next };
      // Universal/deep links can point to a non-http Strava app URL. Do not
      // follow those server-side; the activity id may still be present in the
      // Location header or the next hop can be an ordinary web URL.
      if (!/^https?:$/i.test(new URL(next).protocol)) break;
      current = next;
      continue;
    }

    const text = await response.text().catch(() => '');
    const id = extractActivityId(current, response.url || current) || extractActivityId(text);
    if (id) return { activityId: id, resolvedUrl: response.url || current, html: text };

    // A successful HTML response without an activity id is still useful to
    // the caller for diagnostics/public-page parsing.
    return { activityId: '', resolvedUrl: response.url || current, html: text, status: response.status };
  }
  return { activityId: '', resolvedUrl: current };
}

async function resolveActivityLink(input) {
  const raw = String(input || '').trim();
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('Paste a valid Strava activity link.'); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!['strava.com','strava.app.link'].includes(host) && !host.endsWith('.strava.app.link')) {
    throw new Error('This is not a supported Strava activity link.');
  }

  const direct = extractActivityId(raw);
  if (direct) return { activityId: direct, resolvedUrl: raw };

  const expanded = await fetchRedirectTarget(raw);
  if (expanded.activityId) return expanded;

  // Last public-page attempt. Strava may return a canonical activity URL in
  // HTML/meta tags even when the short-link redirect is not exposed as a
  // normal HTTP Location header.
  if (expanded.html) {
    const htmlId = extractActivityId(expanded.html);
    if (htmlId) return { activityId: htmlId, resolvedUrl: expanded.resolvedUrl, html: expanded.html };
    const canonical = expanded.html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
      expanded.html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
    const canonicalId = extractActivityId(canonical);
    if (canonicalId) return { activityId: canonicalId, resolvedUrl: canonical, html: expanded.html };
  }

  throw new Error('Could not resolve this Strava share link to an activity. Make sure the activity and profile are public, then try again. You can also paste the full strava.com/activities/… URL or use the GPX fallback.');
}

function normalizeNumber(v){const n=Number(v);return Number.isFinite(n)?n:0;}
function decodeHtmlEntities(s){return String(s||'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function findInObject(root, keys){
  const wanted=new Set(keys.map(k=>String(k).toLowerCase()));
  const seen=new Set(); let found={};
  function walk(v,depth){
    if(depth>12||v==null||Object.keys(found).length===keys.length)return;
    if(typeof v==='object'){
      if(seen.has(v))return; seen.add(v);
      for(const [k,val] of Object.entries(v)){
        const lk=k.toLowerCase();
        if(wanted.has(lk) && val!=null && found[lk]==null) found[lk]=val;
        if(typeof val==='object')walk(val,depth+1);
      }
    }
  }
  walk(root,0); return found;
}
function extractEmbeddedObjects(html){
  const out=[]; const raw=String(html||'');
  const scripts=[...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
  for(const text of scripts){
    const t=text.trim();
    if(!t || (!t.includes('polyline') && !t.includes('distance') && !t.includes('total_elevation_gain'))) continue;
    const candidates=[];
    const next=t.match(/<\/?.*?>/)?'':t;
    candidates.push(t);
    const jsonMatches=t.match(/\{[\s\S]*\}/g)||[];
    candidates.push(...jsonMatches.slice(0,8));
    for(const c of candidates){
      try{out.push(JSON.parse(decodeHtmlEntities(c)));}catch(_){
        const m=c.match(/(?:window\.[A-Za-z0-9_$]+|__NEXT_DATA__|__INITIAL_STATE__)\s*=\s*(\{[\s\S]*?\});?\s*$/);
        if(m){try{out.push(JSON.parse(decodeHtmlEntities(m[1])));}catch(__){}}
      }
    }
  }
  return out;
}
function metaContent(html,name){
  const re=new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["'][^>]+content=["']([^"']*)["'][^>]*>`,`i`);
  const m=String(html||'').match(re); return m?decodeHtmlEntities(m[1]):'';
}
function parsePublicActivityHtml(html, resolvedUrl, activityId){
  const raw=String(html||'');
  const objects=extractEmbeddedObjects(raw);
  let candidate={};
  for(const obj of objects){const f=findInObject(obj,['id','name','distance','moving_time','elapsed_time','total_elevation_gain','start_date','start_date_local','sport_type','type','visibility','summary_polyline','polyline']); if(Object.keys(f).length>Object.keys(candidate).length)candidate=f;}
  const text=raw.replace(/\s+/g,' ');
  const distance=normalizeNumber(candidate.distance) || normalizeNumber((text.match(/"distance"\s*:\s*([0-9.]+)/i)||[])[1]);
  const moving=normalizeNumber(candidate.moving_time) || normalizeNumber((text.match(/"moving_time"\s*:\s*(\d+)/i)||[])[1]);
  const elapsed=normalizeNumber(candidate.elapsed_time) || normalizeNumber((text.match(/"elapsed_time"\s*:\s*(\d+)/i)||[])[1]);
  const elevation=normalizeNumber(candidate.total_elevation_gain) || normalizeNumber((text.match(/"total_elevation_gain"\s*:\s*([0-9.]+)/i)||[])[1]);
  const poly=String(candidate.summary_polyline||candidate.polyline||'') || ((text.match(/"(?:summary_polyline|polyline)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)||[])[1]||'').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
  const name=String(candidate.name||'') || metaContent(raw,'og:title') || 'Strava Activity';
  const sport=String(candidate.sport_type||candidate.type||'Run');
  const start=String(candidate.start_date_local||candidate.start_date||'');
  const vis=String(candidate.visibility||'public');
  if(!poly) throw new Error('Public activity page was reachable, but its route geometry is not exposed. Export the activity as GPX and use the GPX fallback.');
  return {id:String(activityId||candidate.id||''),name,sportType:sport,distanceKm:distance/1000,movingTime:moving,elapsedTime:elapsed,elevationGain:elevation,startDate:start,startDateLocal:start,visibility:vis,summaryPolyline:poly,athleteName:'',source:'strava-public',resolvedUrl};
}
async function fetchPublicPage(url){
  // Strava serves a 404 to non-browser user agents, so use the same browser UA
  // as fetchRedirectTarget(); otherwise every public import fails outright.
  const r=await fetch(url,{redirect:'follow',headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language':'en-US,en;q=0.9'
  }});
  const html=await r.text().catch(()=> '');
  if(!r.ok) throw new Error(`Strava public page could not be loaded (${r.status}).`);
  return {html,resolvedUrl:r.url||url};
}
// Public page fetches are rate-limited (and sometimes blocked with 403), so a
// repeated request for the same activity must not hit Strava again.
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();
function cacheGet(key){
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value){
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

async function getPublicActivity(input){
  const resolved=await resolveActivityLink(input);
  let activityId=resolved.activityId;
  if(!activityId) activityId=extractActivityId(resolved.resolvedUrl||'');
  if(!activityId) throw new Error('Could not identify the activity from this public link.');

  const cached=cacheGet(activityId);
  if(cached) return cached;

  // Try EVERY public source in turn. Previously the embed was only attempted
  // when *parsing* failed, so a 403 while *fetching* the main page aborted the
  // whole import even though the embed page might still have worked.
  const sources=[];
  if (resolved.html && resolved.resolvedUrl) sources.push({html:resolved.html,resolvedUrl:resolved.resolvedUrl,tag:'shared link'});
  sources.push({url:`https://www.strava.com/activities/${activityId}`,tag:'public page'});
  sources.push({url:`https://strava-embeds.com/activity/${activityId}`,tag:'public embed'});

  const failures=[];
  for (const src of sources){
    try{
      const page = src.html ? {html:src.html,resolvedUrl:src.resolvedUrl} : await fetchPublicPage(src.url);
      // throws when the page loads but exposes no route geometry
      const parsed = parsePublicActivityHtml(page.html, page.resolvedUrl, activityId);
      cacheSet(activityId, parsed);
      return parsed;
    }catch(e){
      failures.push(`${src.tag}: ${e?.message || 'failed'}`);
    }
  }
  throw new Error(`Unable to read this public Strava activity (${failures.join(' | ')}). It must be PUBLIC (or your own). Otherwise open the activity on strava.com and use ⋮ → Export GPX, then upload it here.`);
}

module.exports = { extractActivityId, resolveActivityLink, parsePublicActivityHtml, fetchPublicPage, getPublicActivity };
