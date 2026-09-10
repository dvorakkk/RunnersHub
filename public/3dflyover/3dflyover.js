/* PHASE 5F v11 — 3D Flyover modular orchestrator */
import { buildCameraModel, pointAtDistance, cameraSample, bearingBetween } from './route-simplifier.js?v=28';
import { createCinematicCamera } from './camera.js?v=28';
import { parseGpxPoints } from './gpx-parser.js?v=28';
(function(){
  const state={mounted:false,map:null,marker:null,activity:null,route:null,gpxPoints:null,terrainProfile:null,playing:false,paused:false,raf:0,startedAt:0,pausedAt:0,pausedElapsed:0,previewModel:null,markerModel:null,previewProgress:0,markerStyle:'runner',runnerDot:false,markerColor:'#FC5200',mapLibre:null,lineColor:'#38BDF8',cameraController:null,durationSeconds:20,lineWidth:5,cameraSpeed:1,
    hudProgress:0,elevModel:null,paceModel:null,hudTotalM:0,paceEstimated:false,
    aspectIndex:0,statPrefs:null,lastVideo:null,routeType:'Trail',flyoverShared:false,generateConfirmed:false};
  const C=()=>window.RUNNERSHUB_CONFIG?.threeD||{};
  // Debug overlay (perf counters) is a development tool: it must never pop up
  // for real visitors on the deployed site.
  const c3Debug=()=>!!(C().debug||/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(String(location.hostname||'')));
  const P=()=>window.RUNNERSHUB_CONFIG?.points||{};
  const $=id=>document.getElementById(id);
  function decodePolyline(str){let index=0,lat=0,lng=0,out=[];while(index<str.length){let b,shift=0,result=0;do{b=str.charCodeAt(index++)-63;result|=(b&31)<<shift;shift+=5;}while(b>=32);lat+=((result&1)?~(result>>1):(result>>1));shift=0;result=0;do{b=str.charCodeAt(index++)-63;result|=(b&31)<<shift;shift+=5;}while(b>=32);lng+=((result&1)?~(result>>1):(result>>1));out.push([lng/1e5,lat/1e5]);}return out;}
  function fmtTime(sec){sec=Math.max(0,Number(sec)||0);const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=Math.floor(sec%60);return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}
  function fmtPace(sec,km){if(!(sec>0&&km>0))return '—';const t=Math.round(sec/km),m=Math.floor(t/60),s=t%60;return `${m}:${String(s).padStart(2,'0')}/km`;}
  function distanceKm(coords){let d=0;const R=6371000;for(let i=1;i<coords.length;i++){const [lon1,lat1]=coords[i-1].map(v=>v*Math.PI/180),[lon2,lat2]=coords[i].map(v=>v*Math.PI/180);const a=Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin((lon2-lon1)/2)**2;d+=2*R*Math.asin(Math.min(1,Math.sqrt(a)));}return d/1000;}
  // Difficulty is derived from an ESTIMATED TIME on the course, not from a bare
  // distance+elevation sum — a 5 km with 800 m of climbing is a different animal
  // from a flat 13 km, even though both score the same "km-effort".
  //   Pace starts at ~11 km/h on the flat and drops with distance (a 40 km is
  //   not run at 5 km pace); every 500 m of ascent adds ~1 hour (Naismith).
  function difficultyHours(a){
    const d=Math.max(0,Number(a?.distanceKm)||0), e=Math.max(0,Number(a?.elevationGain)||0);
    const speed=Math.max(6,11-Math.min(4,d/10));   // long efforts are slower
    return d/speed + e/500;
  }
  function difficulty(a){
    const h=difficultyHours(a);
    return h<1?'Easy':h<2?'Moderate':h<3.5?'Hard':h<5.5?'Very Hard':'Extreme';
  }
  // ─── Preferences (remembered per browser) ───────────────────────────────
  // Marker/line colour, duration, camera speed, line thickness, the "show at
  // finish" checkboxes and the export ratio are restored on the next visit
  // instead of resetting to defaults every time the page is opened.
  const C3_PREFS_KEY='runnershub.create3d.prefs.v1';
  // Export frame ratios (index 0 = the classic vertical social clip).
  // Route type is a display choice: GPX files have no sport field, so the user
  // picks Road/Trail and it shows up on the finish card and in the summary.
  const C3_ROUTE_TYPES=['Trail','Road'];
  function setRouteType(type){
    state.routeType=C3_ROUTE_TYPES.includes(type)?type:'Trail';
    document.querySelectorAll('[data-c3-route-type]').forEach(b=>b.classList.toggle('active',b.dataset.c3RouteType===state.routeType));
    if(state.activity)state.activity.sportType=state.routeType;
    try{renderStats();}catch(_){}
    if(state.activity&&!state.playing)showFinish();
    savePrefs();
  }
  const C3_ASPECTS=[
    {label:'9:16', w:9,  h:16, target:'1080 × 1920'},
    {label:'1:1',  w:1,  h:1,  target:'1080 × 1080'},
    {label:'16:9', w:16, h:9,  target:'1920 × 1080'}
  ];
  function currentAspect(){return C3_ASPECTS[Math.max(0,Math.min(C3_ASPECTS.length-1,state.aspectIndex|0))];}
  function loadPrefs(){
    let p=null;
    try{p=JSON.parse(localStorage.getItem(C3_PREFS_KEY)||'null');}catch(_){p=null;}
    if(!p||typeof p!=='object')return;
    if(C3_MARKER_COLORS.includes(p.markerColor))state.markerColor=p.markerColor;
    if(typeof p.lineColor==='string'&&/^#[0-9a-fA-F]{6}$/.test(p.lineColor))state.lineColor=p.lineColor;
    if(Number.isFinite(p.durationSeconds))state.durationSeconds=Math.max(8,Math.min(60,p.durationSeconds));
    if(Number.isFinite(p.cameraSpeed))state.cameraSpeed=Math.max(.5,Math.min(2,p.cameraSpeed));
    if(Number.isFinite(p.lineWidth))state.lineWidth=Math.max(2,Math.min(10,p.lineWidth));
    if(Number.isFinite(p.aspectIndex))state.aspectIndex=Math.max(0,Math.min(C3_ASPECTS.length-1,Math.round(p.aspectIndex)));
    if(C3_ROUTE_TYPES.includes(p.routeType))state.routeType=p.routeType;
    state.statPrefs=(p.statPrefs&&typeof p.statPrefs==='object')?p.statPrefs:null;
  }
  function savePrefs(){
    try{
      const statPrefs={};
      document.querySelectorAll('#create3d-workspace [data-c3stat]').forEach(cb=>{statPrefs[cb.dataset.c3stat]=!!cb.checked;});
      localStorage.setItem(C3_PREFS_KEY,JSON.stringify({
        markerColor:state.markerColor,lineColor:state.lineColor,
        durationSeconds:state.durationSeconds,cameraSpeed:state.cameraSpeed,
        lineWidth:state.lineWidth,aspectIndex:state.aspectIndex,routeType:state.routeType,statPrefs
      }));
    }catch(_){}
  }
  function applyPrefsToUi(){
    document.querySelectorAll('[data-c3-marker-color]').forEach(b=>b.classList.toggle('active',b.dataset.c3MarkerColor===state.markerColor));
    document.querySelectorAll('[data-c3-line-color]').forEach(b=>b.classList.toggle('active',b.dataset.c3LineColor===state.lineColor));
    document.querySelectorAll('[data-c3-ratio]').forEach(b=>b.classList.toggle('active',Number(b.dataset.c3Ratio)===state.aspectIndex));
    document.querySelectorAll('[data-c3-route-type]').forEach(b=>b.classList.toggle('active',b.dataset.c3RouteType===state.routeType));
    const sp=state.statPrefs;
    if(sp)document.querySelectorAll('#create3d-workspace [data-c3stat]').forEach(cb=>{if(typeof sp[cb.dataset.c3stat]==='boolean')cb.checked=sp[cb.dataset.c3stat];});
    updateAspectLabel();
    try{updatePlaybackUi();}catch(_){}
  }
  function updateAspectLabel(){
    const el=$('c3-video-format');if(!el)return;
    const a=currentAspect();
    el.textContent=a.target+' · '+a.label;
  }
  function setAspect(i){
    state.aspectIndex=Math.max(0,Math.min(C3_ASPECTS.length-1,Math.round(Number(i)||0)));
    document.querySelectorAll('[data-c3-ratio]').forEach(b=>b.classList.toggle('active',Number(b.dataset.c3Ratio)===state.aspectIndex));
    updateAspectLabel();savePrefs();
  }
  // ─── Recording format ───────────────────────────────────────────────────
  // MP4 is the preferred output (iPhone/Safari and every editor accept it).
  // WebM stays as the fallback for browsers whose MediaRecorder cannot encode
  // H.264 — the first type the browser actually supports wins.
  const C3_VIDEO_TYPES=[
    // High/Main profile before Baseline: noticeably cleaner on fast camera
    // moves at the same bitrate (better motion estimation + CABAC).
    {mime:'video/mp4;codecs=avc1.640033,mp4a.40.2',ext:'mp4'},
    {mime:'video/mp4;codecs=avc1.640028,mp4a.40.2',ext:'mp4'},
    {mime:'video/mp4;codecs=avc1.4D4028,mp4a.40.2',ext:'mp4'},
    {mime:'video/mp4;codecs=avc1.42E01E,mp4a.40.2',ext:'mp4'},
    {mime:'video/mp4;codecs=avc1',ext:'mp4'},
    {mime:'video/mp4',ext:'mp4'},
    {mime:'video/webm;codecs=vp9,opus',ext:'webm'},
    {mime:'video/webm;codecs=vp9',ext:'webm'},
    {mime:'video/webm',ext:'webm'}
  ];
  function c3PickVideoType(){
    if(typeof MediaRecorder!=='undefined'&&typeof MediaRecorder.isTypeSupported==='function'){
      for(const t of C3_VIDEO_TYPES){try{if(MediaRecorder.isTypeSupported(t.mime))return t;}catch(_){}}
    }
    return C3_VIDEO_TYPES[C3_VIDEO_TYPES.length-1];
  }
  function setStatus(text,type=''){const e=$('create3d-import-status');if(e){e.textContent=text;e.className='create3d-status '+type;}}
  function renderConnection(status){state.connected=!!status?.connected;const btn=$('create3d-connect-btn'),pill=$('create3d-strava-user');if(btn)btn.textContent=state.connected?'Reconnect Strava':'Connect Strava';if(pill)pill.textContent=state.connected?('✓ Connected'+(status.connection?.athlete_name?' · '+status.connection.athlete_name:'')):'Public import';const myBtn=$('create3d-my-btn');const myList=$('create3d-my-list');if(myBtn)myBtn.hidden=!state.connected;if(myList&&!state.connected)myList.innerHTML='';}
  async function checkConnection(){try{const r=await callApi('stravaStatus',{runnerId:getRunnerId()});renderConnection(r);}catch(e){console.warn('[create3d] Strava status unavailable:',e.message);}}
  async function connect(){try{const r=await callApi('stravaConnect',{runnerId:getRunnerId()});if(!r?.authorizeUrl)throw new Error('Strava connection URL was not returned.');window.location.href=r.authorizeUrl;}catch(e){setStatus(e.message||'Could not start Strava connection.','err');}}
  let maplibrePromise=null;
  function checkWebGLSupport(){try{const c=document.createElement('canvas');const gl=c.getContext('webgl')||c.getContext('webgl2');return !!gl;}catch(e){return false;}}
  async function getMapLibre(){
    // dist/maplibre-gl.js is a UMD build: it exposes the engine as the GLOBAL
    // maplibregl (window.maplibregl) and has NO module exports, so after a
    // dynamic import() the namespace object is empty. Always read the API from
    // window.maplibregl and mirror it to window.__RUNNERSHUB_MAPLIBRE__ so both
    // fallbacks stay in sync — otherwise initMap() can hit `undefined.Map` and
    // throw "Cannot read properties of undefined (reading 'Map')".
    if(window.__RUNNERSHUB_MAPLIBRE__) return window.__RUNNERSHUB_MAPLIBRE__;
    if(window.maplibregl?.Map){
      window.__RUNNERSHUB_MAPLIBRE__=window.maplibregl;
      return window.maplibregl;
    }
    if(!maplibrePromise){
      maplibrePromise=(async()=>{
        let lastError=null;
        if(!checkWebGLSupport()){maplibrePromise=null;throw new Error('WebGL is not supported on this device. 3D preview requires WebGL 1.0+.');}
        // Wait for the MapLibre stylesheet when it exists, but never hang the
        // preview if the stylesheet is blocked or slow.
        await Promise.race([window.__MAP_CSS_READY__||Promise.resolve(),new Promise(r=>setTimeout(r,8000))]);
        for(let attempt=0;attempt<4;attempt++){
          try{
            if(!window.maplibregl) await import('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');
            const api=window.maplibregl; // UMD factory populates this global.
            if(!api?.Map||!api?.Marker) throw new Error('MapLibre incomplete');
            if(!api.NavigationControl) throw new Error('MapLibre controls missing');
            window.__RUNNERSHUB_MAPLIBRE__=api;
            return api;
          }catch(e){
            lastError=e;
            console.error(`[MapLibre] Attempt ${attempt+1} failed:`,e.message);
            if(attempt<3){
              const delay=1000+(attempt*750)+Math.random()*500;
              await new Promise(r=>setTimeout(r,delay));
            }
          }
        }
        maplibrePromise=null;
        const hint=lastError?.message?.includes('adblocker')?'Check your content blockers':'Check your internet connection and WebGL support';
        throw new Error(`3D map engine failed (${lastError?.message||'unknown'}). ${hint}.`);
      })();
    }
    return maplibrePromise;
  }
  const C3_SAT_TILES='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  // Global public elevation tiles. Terrarium values are decoded natively by
  // MapLibre. The URL is configurable (config.js → threeD.map.terrainUrl) so a
  // dead tileset can be swapped without editing this module.
  const C3_DEM_TILES_DEFAULT='https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const c3DemTiles=()=>String(C().map?.terrainUrl||'').trim()||C3_DEM_TILES_DEFAULT;
  // Terrarium tiles come from the Mapzen terrain dataset hosted on the AWS Open
  // Data registry — both credits are required by the ODbL licence.
  const C3_DEM_ATTRIBUTION='Elevation © Mapzen / AWS Terrain Tiles (ODbL)';
  function buildStyle(){
    return {version:8,sources:{
      base:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,maxzoom:19,attribution:'© OpenStreetMap contributors'},
      satellite:{type:'raster',tiles:[C3_SAT_TILES],tileSize:256,maxzoom:18,attribution:'Tiles © Esri'},
      terrainSource:{type:'raster-dem',tiles:[c3DemTiles()],tileSize:256,minzoom:0,maxzoom:15,encoding:'terrarium',attribution:C3_DEM_ATTRIBUTION}
    },layers:[
      {id:'base',type:'raster',source:'base'},
      {id:'satellite',type:'raster',source:'satellite',layout:{visibility:'none'}}
    ]};
  }
  function boundsOf(coords){let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;coords.forEach(([x,y])=>{minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)});return [[minX,minY],[maxX,maxY]];}
  function c3Progress(percent,label,title,step){
    const fill=$('c3-progress-fill'),pct=$('c3-progress-pct'),lbl=$('c3-progress-label'),ttl=$('c3-loading-title');
    if(fill)fill.style.width=Math.max(0,Math.min(100,percent))+'%'; if(pct)pct.textContent=Math.round(percent)+'%'; if(lbl)lbl.textContent=label||''; if(ttl)ttl.textContent=title||label||'';
    const order=['parse','validate','location','map','terrain','ready'];
    document.querySelectorAll('#c3-loading-steps [data-c3-step]').forEach(el=>{const done=order.indexOf(el.dataset.c3Step)<order.indexOf(step);el.classList.toggle('done',done);el.classList.toggle('current',el.dataset.c3Step===step);if(done)el.textContent='✓ '+el.textContent.replace(/^. /,'');});
  }
  function c3HideLoading(){const o=$('create3d-loading-overlay');if(o)o.classList.add('hidden');}
  function c3ShowLoading(){const o=$('create3d-loading-overlay');if(o)o.classList.remove('hidden');c3Progress(0,'Starting','Preparing 3D preview','parse');}
  function setMapMode(mode){
    if(!state.map)return;
    const sat=mode==='satellite';
    try{state.map.setLayoutProperty('base','visibility',sat?'none':'visible');state.map.setLayoutProperty('satellite','visibility',sat?'visible':'none');}
    catch(e){console.warn('[RunnersHub 3D] basemap switch failed',e);}
    document.querySelectorAll('[data-c3-map-mode]').forEach(b=>b.classList.toggle('active',b.dataset.c3MapMode===mode));
    state.mapMode=mode;
  }
  function runnerSvg(){
    // Small inline SVG of a running figure. Limbs rotate via CSS keyframes
    // (.c3-running on the marker) so the person strides instead of being a
    // static emoji. Pivots live at shoulder/hip so rotations look natural.
    const NS='http://www.w3.org/2000/svg';
    const add=(tag,attrs,children=[])=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);children.forEach(c=>e.appendChild(c));return e;};
    const svg=add('svg',{class:'c3-runner-svg',viewBox:'0 0 64 64',width:'100%',height:'100%','aria-hidden':'true',focusable:'false'});
    const shadow=add('ellipse',{cx:32,cy:57,rx:15,ry:3,class:'c3-shadow'});
    const head=add('circle',{cx:32,cy:16,r:8.5,class:'c3-head'});
    const torso=add('rect',{x:26.5,y:23,width:11,height:15,rx:3,class:'c3-torso'});
    const armL=add('g',{class:'c3-limb c3-arm-l'},[add('line',{x1:27,y1:24,x2:18,y2:40,class:'c3-arm'})]);
    const armR=add('g',{class:'c3-limb c3-arm-r'},[add('line',{x1:37,y1:24,x2:46,y2:40,class:'c3-arm'})]);
    const legL=add('g',{class:'c3-limb c3-leg-l'},[add('line',{x1:29,y1:38,x2:20,y2:55,class:'c3-leg'})]);
    const legR=add('g',{class:'c3-limb c3-leg-r'},[add('line',{x1:35,y1:38,x2:44,y2:55,class:'c3-leg'})]);
    const figure=add('g',{class:'c3-figure'},[head,torso,armL,armR,legL,legR]);
    svg.appendChild(shadow);svg.appendChild(figure);
    return svg;
  }
  function setRunnerAnim(on){
    const el=$('create3d-runner-marker');
    if(el)el.classList.toggle('c3-running',!!on&&state.markerStyle==='runner');
  }
  function refreshRunnerContent(){
    const el=$('create3d-runner-marker');
    if(!el)return;
    el.classList.toggle('runner-mode',state.markerStyle==='runner');
    el.querySelectorAll('.c3-runner-svg').forEach(n=>n.remove());
    const span=el.querySelector('span');if(span)span.textContent='●';
    setRunnerAnim(false);
  }
  // ── Running marker ────────────────────────────────────────────────────────
  // The marker is drawn INSIDE the WebGL map as a single GL circle layer, never
  // as a DOM element: DOM markers live outside <canvas>, so they are never
  // captured in the recorded video. One circle layer + one point source keeps
  // the live preview and the exported WebM identical, and its colour follows the
  // "Running marker" UI option (orange or blue).
  const C3_MARKER_COLORS=['#FC5200','#38BDF8'];
  function c3Rgba(hex,a){
    const h=String(hex||'#FC5200').replace('#','');
    const n=parseInt(h.length===3?h.split('').map(x=>x+x).join(''):h,16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
  }
  function runnerDotPaint(){
    return {
      'circle-radius':9,
      'circle-color':state.markerColor||'#FC5200',
      'circle-stroke-width':3,
      'circle-stroke-color':'#ffffff',
      'circle-opacity':1,
      'circle-stroke-opacity':1
    };
  }
  function installRunnerDot(){
    if(!state.map||!state.route?.length)return false;
    try{
      if(!state.map.getSource('runner-src')) state.map.addSource('runner-src',{type:'geojson',data:{type:'Feature',geometry:{type:'Point',coordinates:state.route[0]}}});
      if(!state.map.getLayer('runner-dot')) state.map.addLayer({id:'runner-dot',type:'circle',source:'runner-src',paint:runnerDotPaint()});
      state.runnerDot=true;
      applyMarkerColor();
      return true;
    }catch(e){
      console.warn('[RunnersHub 3D] GL runner marker unavailable:',e?.message);
      state.runnerDot=false;
      return false;
    }
  }
  function removeRunnerDot(){
    if(!state.map)return;
    try{if(state.map.getLayer('runner-dot'))state.map.removeLayer('runner-dot');}catch(_){}
    try{if(state.map.getSource('runner-src'))state.map.removeSource('runner-src');}catch(_){}
    state.runnerDot=false;
  }
  function setRunnerDotPos(p){
    if(!state.map||!p)return;
    const data={type:'Feature',geometry:{type:'Point',coordinates:p},properties:{}};
    // setData() is the correct per-frame update: calling map.setSource() on every
    // animation frame re-created the source, so the dot never rendered/moved.
    try{
      const src=state.map.getSource('runner-src');
      if(src&&typeof src.setData==='function'){src.setData(data);return;}
      state.map.setSource('runner-src',{type:'geojson',data});
    }catch(_){}
  }
  // Colour the GL marker and keep the (hidden) DOM marker in sync for the fallback.
  function applyMarkerColor(){
    const col=C3_MARKER_COLORS.includes(state.markerColor)?state.markerColor:'#FC5200';
    if(state.map&&state.map.getLayer('runner-dot')){
      try{state.map.setPaintProperty('runner-dot','circle-color',col);}catch(_){}
    }
    const el=$('create3d-runner-marker');
    if(el){el.style.background=col;el.style.boxShadow=`0 0 0 5px ${c3Rgba(col,.22)},0 8px 20px rgba(0,0,0,.45)`;}
    document.querySelectorAll('[data-c3-marker-color]').forEach(b=>b.classList.toggle('active',b.dataset.c3MarkerColor===col));
  }
  function setMarkerColor(color){
    state.markerColor=C3_MARKER_COLORS.includes(color)?color:'#FC5200';
    applyMarkerColor();savePrefs();
  }
  // The DOM dot is only a fallback for engines that cannot add the GL circle
  // layer. While it is unattached it is a static child of .create3d-map-shell,
  // and `will-change:transform` promotes it above the canvas — it showed up as
  // a stray orange dot in the map's top-left corner. The CSS rule hides it
  // whenever it is a direct child of the shell (i.e. not attached to a marker),
  // and the class below re-enables it for the fallback path.
  function ensureDomMarkerEl(){
    let el=$('create3d-runner-marker');
    if(!el){
      const shell=document.querySelector('.create3d-map-shell');
      if(!shell)return null;
      el=document.createElement('div');
      el.id='create3d-runner-marker';
      el.className='create3d-runner-marker';
      el.setAttribute('aria-hidden','true');
      el.innerHTML='<span>●</span>';
      shell.appendChild(el);
    }
    return el;
  }
  function hideDomMarker(){
    const el=ensureDomMarkerEl();if(!el)return;
    el.classList.remove('c3-dom-marker-on');
    el.style.display='none';
  }
  function showDomMarker(ml){
    const el=ensureDomMarkerEl();if(!el)return;
    el.classList.add('c3-dom-marker-on');
    el.style.display='grid';
    if(!state.marker&&ml&&state.map&&state.route?.length){
      try{
        refreshRunnerContent();
        state.marker=new ml.Marker({element:el,anchor:'center'}).setLngLat(state.route[0]).addTo(state.map);
      }catch(e){console.warn('[RunnersHub 3D] DOM marker failed:',e.message);}
    }
  }
  function installRunnerMarker(maplibregl){
    state.mapLibre=maplibregl||state.mapLibre;
    if(state.marker){try{state.marker.remove();}catch(_){} state.marker=null;}
    // The GL dot is the real marker — it renders inside the canvas, so it is
    // captured in the exported video. The DOM element is only a fallback.
    if(installRunnerDot()){hideDomMarker();return null;}
    showDomMarker(state.mapLibre);
    return state.marker;
  }
  // The animated 3D runner option was removed: the marker is a single GL dot and
  // its colour is switched with setMarkerColor().
  function setTerrainVisibility(){
    if(!state.map)return;
    try{
      const ex=Number(C().map?.exaggeration||1.15);
      state.map.setTerrain({source:'terrainSource',exaggeration:ex});
    }catch(e){console.warn('[RunnersHub 3D] terrain enable failed:',e);}
  }
  async function validateTerrainElevation(pts){
    const status=$('create3d-elevation-status');
    if(!state.map||typeof state.map.queryTerrainElevation!=='function'){
      if(status){status.className='create3d-elevation-status warn';status.textContent='⚠️ Terrain cannot be sampled on this device.'}
      return;
    }
    window.updatePerfStats?.('terrain_start','Terrain validation');
    const source=Array.isArray(pts)?pts:state.route.map(p=>({lon:p[0],lat:p[1],ele:null}));
    let samples=[];
    for(let attempt=0;attempt<8 && samples.length<3;attempt++){
      samples=[];
      const stride=Math.max(1,Math.floor(source.length/24));
      for(let i=0;i<source.length;i+=stride){
        const p=source[i];
        try{
          const z=state.map.queryTerrainElevation([p.lon??p[0],p.lat??p[1]],{exaggerated:false});
          if(Number.isFinite(z))samples.push({gpx:Number.isFinite(p.ele)?p.ele:null,terrain:z});
        }catch(_){}
      }
      if(samples.length<3){
        const waitMs=Math.min(800,200+(attempt*150));
        await new Promise(r=>setTimeout(r,waitMs));
      }
    }
    window.updatePerfStats?.('terrain_ready','Terrain ready');
    state.terrainProfile=samples;
    if(!samples.length){
      if(status){status.className='create3d-elevation-status warn';status.textContent='⚠️ Terrain layer is active, but elevation samples are not available yet. The 3D route can still be previewed.';}
      return;
    }
    const gpx=samples.filter(x=>Number.isFinite(x.gpx));
    if(gpx.length>=3){
      const mae=gpx.reduce((a,x)=>a+Math.abs(x.gpx-x.terrain),0)/gpx.length;
      const maxErr=Math.max(...gpx.map(x=>Math.abs(x.gpx-x.terrain)));
      const text=`✓ Terrain elevation validated · ${samples.length} samples · mean difference ${Math.round(mae)} m · max ${Math.round(maxErr)} m`;
      if(status){status.className='create3d-elevation-status '+(mae<=80?'ok':'warn');status.textContent=mae<=80?text:text+' — GPX and DEM can differ because they use different elevation sources.';}
    }else{
      const vals=samples.map(x=>x.terrain);
      const min=Math.round(Math.min(...vals)),max=Math.round(Math.max(...vals));
      if(status){status.className='create3d-elevation-status ok';status.textContent=`✓ Terrain elevation available · ${samples.length} samples · ${min}–${max} m`; }
    }
  }
  async function initMap(coords){
    if(!Array.isArray(coords)||coords.length<2) throw new Error('Route has too few coordinates for 3D preview.');
    c3ShowLoading();
    window.updatePerfStats?.('maplibre_start','MapLibre load');
    let maplibregl=null;
    try{
      maplibregl=await getMapLibre();
      if(!maplibregl?.Map) throw new Error('3D map engine is unavailable.');
      window.updatePerfStats?.('maplibre_ready','MapLibre ready');
    }catch(e){
      c3HideLoading();
      window.showC3Error?.('3D Engine Error',e.message,()=>location.reload());
      throw e;
    }
    if(!window.isSecureContext && location.hostname!=='localhost') throw new Error('3D preview requires a secure HTTPS connection.');
    const el=document.getElementById('create3d-map'); if(!el) throw new Error('3D map container is missing.');
    if(state.map){
      removeRunnerDot();
      try{state.marker?.remove();state.cameraController?.reset();state.map.off();state.map.remove();state.map=null;}catch(e){console.warn('[Cleanup]',e.message);}
    }
    while(el.firstChild)el.removeChild(el.firstChild);
    c3Progress(52,'Map engine ready','Building the 3D map…','map');
    // Use the engine resolved by getMapLibre() above. Re-reading the module global
    // here caused "Cannot read properties of undefined (reading 'Map')" whenever
    // MapLibre had been cached only on window.maplibregl.
    try{
      // preserveDrawingBuffer:true keeps the last rendered WebGL frame readable,
      // which is what lets recordPreviewToVideo() copy the map canvas onto the 2D
      // compositing canvas (where the finish card is painted into the video).
      state.map=new maplibregl.Map({container:el,style:buildStyle(),center:coords[Math.floor(coords.length/2)],zoom:11,pitch:62,bearing:0,maxPitch:85,renderWorldCopies:false,attributionControl:true,canvasContextAttributes:{antialias:true,preserveDrawingBuffer:true},fadeDuration:0});
      const canvas=state.map.getCanvas();
      canvas.addEventListener('webglcontextlost',(e)=>{e.preventDefault();console.warn('[3D] WebGL context lost');window.showC3Error?.('WebGL Restored','3D context recovered. Reloading...','');setTimeout(()=>location.reload(),2000);});
      state.map.addControl(new maplibregl.NavigationControl({visualizePitch:true,showCompass:true}),'top-right');
      state.map.on('error',e=>{const msg=e?.error?.message||e?.error?.status||'Map resource failed.';console.warn('[RunnersHub 3D]',msg,e);});
    }catch(e){
      c3HideLoading();
      window.showC3Error?.('Map Initialization Failed',e.message,()=>initMap(coords));
      throw e;
    }
    await Promise.race([new Promise((resolve)=>{let done=false;const finish=()=>{if(!done){done=true;resolve();}}; state.map.once('style.load',finish);setTimeout(finish,10000);})]);
    window.updatePerfStats?.('map_ready','Map ready');
    c3Progress(68,'Map ready','Drawing your route…','location');
    try{
      if(!state.map.getSource('activity-route')) state.map.addSource('activity-route',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:coords}}});
      const casingWidth=state.lineWidth*2;
      const routeWidth=state.lineWidth;
      if(!state.map.getLayer('activity-route-casing')) state.map.addLayer({id:'activity-route-casing',type:'line',source:'activity-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'rgba(0,0,0,.72)','line-width':casingWidth,'line-opacity':.72}});
      if(!state.map.getLayer('activity-route')) state.map.addLayer({id:'activity-route',type:'line',source:'activity-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':state.lineColor||'#38BDF8','line-width':routeWidth,'line-opacity':1}});
      applyRouteStyle();
      installRunnerMarker(maplibregl);
      state.map.fitBounds(boundsOf(coords),{padding:{top:100,bottom:100,left:100,right:100},maxZoom:14,duration:0});
    }catch(err){throw new Error('Route could not be drawn on the map.');}
    c3Progress(78,'Route ready','Loading real elevation terrain…','terrain');
    try{
      setTerrainVisibility();
      // Wait only for the first render, not for the entire tile pyramid.
      await new Promise(resolve=>{
        let settled=false;const finish=()=>{if(settled)return;settled=true;resolve();};
        const onRender=()=>{if(state.map.getTerrain())finish();};
        state.map.once('render',onRender);setTimeout(finish,1800);
      });
    }catch(e){console.warn('[RunnersHub 3D] terrain init:',e);}
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await validateTerrainElevation(state.gpxPoints);
    // Force a pronounced 3D camera so flat-map rendering is not mistaken for terrain mode.
    state.map.setPitch(68);
    state.map.setZoom(Math.min(14,Math.max(10,state.map.getZoom())));
    c3Progress(94,'Finalizing','Preparing flyover preview…','ready');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    c3Progress(100,'Preview ready','3D preview ready','ready');
    c3HideLoading();
    const previewBtn=$('create3d-preview-btn');if(previewBtn)previewBtn.disabled=false;const playback=$('create3d-preview-playback');if(playback)playback.disabled=false;const pause=$('create3d-preview-pause');if(pause)pause.disabled=true;updatePlaybackUi();
    setMapMode(state.mapMode||'terrain');
    state.map.resize();
    return state.map;
  }
  // ─── CINEMATIC SPLINE CAMERA ───────────────────────────────────────────────
  // The route is converted to a distance-parameterized Catmull-Rom spline.
  // Camera position follows the spline; look-at is solved from a forward sample
  // and smoothed independently. This avoids hard heading jumps at GPX vertices.
  function cumulativeRoute(coords){ return buildCameraModel(coords,{...(C().camera||{}),resampleMeters:12,simplifyTolerance:4}); }
  function formatPreviewTime(ms){const sec=Math.max(0,Math.round(ms/1000));return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');}
  function updatePlaybackUi(){
    const play=$('create3d-preview-playback'),pause=$('create3d-preview-pause'),prog=$('create3d-preview-progress'),slider=$('create3d-preview-scrubber'),time=$('create3d-preview-time'),durInput=$('c3-duration'),speedInput=$('c3-speed'),lineWidthInput=$('c3-line-width'),durVal=$('c3-duration-val'),speedVal=$('c3-speed-val'),lineWidthVal=$('c3-line-width-val');
    const ready=!!state.map&&!!state.route?.length;
    if(play){play.disabled=!ready;play.textContent=state.playing?'▶ Playing':'▶ Preview';}
    if(pause){pause.disabled=!state.playing&&!state.paused;pause.textContent=state.paused?'▶ Resume':'⏸ Pause';}
    if(prog)prog.textContent=Math.round((state.previewProgress||0)*100)+'%';
    const dur=state.durationSeconds*1000;
    if(slider){slider.disabled=!ready;slider.value=String(Math.round((state.previewProgress||0)*1000));}
    if(time)time.textContent=formatPreviewTime((state.previewProgress||0)*dur)+' / '+formatPreviewTime(dur);
    if(durInput)durInput.value=String(state.durationSeconds);
    if(speedInput)speedInput.value=String(state.cameraSpeed.toFixed(1));
    if(lineWidthInput)lineWidthInput.value=String(state.lineWidth);
    if(durVal)durVal.textContent=state.durationSeconds+'s';
    if(speedVal)speedVal.textContent=state.cameraSpeed.toFixed(1)+'x';
    if(lineWidthVal)lineWidthVal.textContent=state.lineWidth+'px';
  }
  function buildLinearModel(coords){const points=[{p:coords[0],d:0}];let total=0;for(let i=1;i<coords.length;i++){total+=distanceBetween(coords[i-1],coords[i]);points.push({p:coords[i],d:total});}return {points,total};}
  function distanceBetween(a,b){const R=6371000,[lon1,lat1]=a.map(v=>v*Math.PI/180),[lon2,lat2]=b.map(v=>v*Math.PI/180);const h=Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin((lon2-lon1)/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
  function linearPoint(model,d){const pts=model.points;if(!pts.length)return [0,0];if(d<=0)return pts[0].p;if(d>=model.total)return pts.at(-1).p;let lo=0,hi=pts.length-1;while(lo<hi){const m=(lo+hi)>>1;if(pts[m].d<d)lo=m+1;else hi=m;}const b=pts[lo],a=pts[lo-1],t=(d-a.d)/Math.max(1e-6,b.d-a.d);return [a.p[0]+(b.p[0]-a.p[0])*t,a.p[1]+(b.p[1]-a.p[1])*t];}
  // Strava/COROS-style camera envelope: keep the tight follow for the WHOLE run,
  // then pull back quickly during the last C3_TAIL_SECONDS so the route and its
  // surroundings are revealed in a fast outro (not a gradual zoom-out).
  const C3_TAIL_SECONDS=1.5;
  function c3CamEnvelope(linear){
    const cc=C().camera||{};
    const z0=Number(cc.zoomStart??15.2), z1=Number(cc.zoomEnd??12.0);
    const p0=Number(cc.pitchStart??64), p1=Number(cc.pitchEnd??42);
    const pr=Math.max(0,Math.min(1,Number(linear)||0));
    const dur=Math.max(1,Number(state.durationMs?state.durationMs/1000:state.durationSeconds)||20);
    // Fraction of the run used by the outro pull-back (0.3 s by default).
    const tail=Math.max(0.01,Math.min(1,Number(cc.tailSeconds??C3_TAIL_SECONDS)/dur));
    const startAt=1-tail;
    const k=pr>startAt?Math.max(0,Math.min(1,(pr-startAt)/tail)):0;
    const e=k*k*(3-2*k);   // ease inside the tail only
    return {zoom:z0+(z1-z0)*e, pitch:p0+(p1-p0)*e, env:e, tail:pr>startAt};
  }
  function applyPreviewFrame(progress,animate=false,instant=false,linearProgress=null){
    if(!state.previewModel||!state.map)return;
    const model=state.previewModel,p=Math.max(0,Math.min(1,progress)),d=p*model.total;
    state.hudProgress=p;   // the HUD (profile dot / pace) tracks the runner exactly
    if(!state.markerModel&&state.route) state.markerModel=buildLinearModel(state.route);
    const mp=state.markerModel;
    const runnerPos=mp?linearPoint(mp,p*mp.total):null;
    const sample=cameraSample(model,d,C().camera||{});
    // Follow the ACTUAL runner position (raw route), not the smoothed spline.
    // Otherwise the dot drifts off-center on curvy tracks and feels "too far".
    if(runnerPos)sample.cur={p:runnerPos};
    if(!state.cameraController) state.cameraController=createCinematicCamera({map:state.map,config:C().camera||{}});
    // linearProgress = raw time fraction (drives the COROS-style zoom-out);
    // p is the eased distance fraction used for motion.
    const lp=Math.max(0,Math.min(1,linearProgress??p));
    const env=c3CamEnvelope(lp);
    // zoom/pitch are passed explicitly so the outro works even if camera.js is
    // served from a cache that ignores the envelope. `snap` bypasses the slow
    // zoom/pitch low-pass during the tail, otherwise 0.3 s is too short to
    // finish the pull-back (the filter time constant alone is ~0.4 s).
    state.cameraController.apply(sample,{progress:lp,zoom:env.zoom,pitch:env.pitch,snap:!!env.tail,animate,instant,curvature:sample.curvature});
    if(state.marker&&runnerPos) state.marker.setLngLat(runnerPos);
    setRunnerDotPos(runnerPos);
  }
  function setPreviewProgressFromSlider(value){
    if(!state.map||!state.route?.length)return;
    state.previewModel=state.previewModel||cumulativeRoute(state.route);
    state.markerModel=state.markerModel||buildLinearModel(state.route||[]);
    state.previewProgress=Math.max(0,Math.min(1,Number(value)/1000));
    state.playing=false;state.paused=true;cancelAnimationFrame(state.raf);state.raf=0;
    applyPreviewFrame(state.previewProgress,false,true);hideFinish();updatePlaybackUi();paintHudCanvas();
  }
  function playPreview(){
    if(!state.map||!state.route?.length)return;
    setRunnerAnim(true);
    hideFinish();document.querySelector('.create3d-map-shell')?.classList.add('previewing');
    buildHudModels();   // elevation profile + per-point pace for the HUD
    state.previewModel=state.previewModel||cumulativeRoute(state.route);
    state.markerModel=state.markerModel||buildLinearModel(state.route||[]);
    state.durationMs=Math.max(8,state.durationSeconds)*1000;
    if(state.paused){state.startedAt=performance.now()-state.pausedElapsed;state.playing=true;state.paused=false;updatePlaybackUi();state.raf=requestAnimationFrame(tickPreview);return;}
    state.cameraController?.reset();
    state.playing=true;state.paused=false;state.pausedElapsed=0;state.previewProgress=0;state._bearing=null;
    state.map.stop();applyPreviewFrame(0,true,true);updatePlaybackUi();state.startedAt=performance.now();state.raf=requestAnimationFrame(tickPreview);
  }
  function tickPreview(now){
    if(!state.playing)return;
    const duration=state.durationMs||20000,model=state.previewModel,p=Math.min(1,(now-state.startedAt)/duration);
    // Smoothstep time curve avoids sudden acceleration at start/finish.
    const t=p*p*(3-2*p);state.previewProgress=p;
    applyPreviewFrame(t,true,false,p);updatePlaybackUi();paintHudCanvas();
    if(p<1){state.raf=requestAnimationFrame(tickPreview);}else{
      state.playing=false;state.paused=false;state.previewProgress=1;state.raf=0;applyPreviewFrame(1,false,true);
      if(state.marker)state.marker.setLngLat(model.points.at(-1).p);updatePlaybackUi();setRunnerAnim(false);shellCleanup();showFinish();
    }
  }
  function pausePreview(){if(!state.playing)return;state.pausedElapsed=performance.now()-state.startedAt;state.playing=false;state.paused=true;cancelAnimationFrame(state.raf);state.raf=0;setRunnerAnim(false);updatePlaybackUi();}
  function stopPreview(){state.playing=false;state.paused=false;state.pausedElapsed=0;cancelAnimationFrame(state.raf);state.raf=0;setRunnerAnim(false);shellCleanup();updatePlaybackUi();clearHudCanvas();}
  function shellCleanup(){document.querySelector('.create3d-map-shell')?.classList.remove('previewing');}
  function resetView(){
    stopPreview();hideFinish();state.previewModel=null;state.markerModel=null;state.cameraController?.reset();state.cameraController=null;state.previewProgress=0;state._bearing=null;state.previewScrubProgress=0;state.hudProgress=0;clearHudCanvas();
    if(state.map&&state.route?.length){state.map.stop();state.map.fitBounds(boundsOf(state.route),{padding:{top:100,bottom:100,left:100,right:100},maxZoom:14,duration:700});state.map.setPitch(68);if(state.marker)state.marker.setLngLat(state.route[0]);}
    updatePlaybackUi();
  }
  function renderStats(){const a=state.activity;if(!a)return;const est=!!a.timeEstimated;const tTxt=(est?'≈ ':'')+fmtTime(a.movingTime);const pace=(est?'≈ ':'')+fmtPace(a.movingTime,a.distanceKm);$('create3d-activity-name').textContent=a.name||'Run Activity';$('create3d-activity-meta').textContent=`${state.routeType||a.sportType||'Run'} · ${a.distanceKm.toFixed(2)} km · ↑ ${Math.round(a.elevationGain||0)} m`;const cards=[['Distance',a.distanceKm.toFixed(2)+' km'],['Time',tTxt],['Pace',pace],['Elevation','↑ '+Math.round(a.elevationGain||0)+' m']];
      if(Number.isFinite(a.avgHr))cards.push(['Avg HR',a.avgHr+' bpm']);
      if(Number.isFinite(a.maxHr)&&Number.isFinite(a.avgHr)&&a.maxHr!==a.avgHr)cards.push(['Max HR',a.maxHr+' bpm']);
      $('create3d-stat-summary').innerHTML=cards.map(x=>`<div class="c3-stat"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('');}
  function customStats(){const a=state.activity;return {distance:a.distanceKm.toFixed(2)+' km',time:$('c3-time').value.trim()||fmtTime(a.movingTime),pace:$('c3-pace').value.trim()||fmtPace(a.movingTime,a.distanceKm),elevation:'↑ '+Math.round(a.elevationGain||0)+' m',difficulty:difficulty(a),date:$('c3-date').value?new Date($('c3-date').value).toLocaleString():new Date(a.startDateLocal||a.startDate||Date.now()).toLocaleString()};}
  // ─── Finish card: one data model, two renderers ─────────────────────────
  // finishStats() is the single source of truth. showFinish() renders it as DOM
  // (what you see on screen) and drawFinishCard() paints the same layout into
  // the video frames with the 2D canvas API — captureStream() only ever sees the
  // WebGL canvas, so a DOM overlay can never be captured. That is exactly why
  // the old finish card was missing from every exported video.
  function statChecked(key){const el=$('create3d-workspace')?.querySelector(`[data-c3stat="${key}"]`);return !el||el.checked;}
  function finishStats(){
    const a=state.activity||{};
    const dist=Number(a.distanceKm||0);
    return {
      name:a.name||'Run Activity',
      sport:String(state.routeType||a.sportType||'Run').toUpperCase(),
      distance:dist.toFixed(2),
      distanceUnit:'KM',
      showDistance:statChecked('distance'),
      time:$('c3-time')?.value.trim()||((a.timeEstimated?'≈ ':'')+fmtTime(a.movingTime)),
      pace:$('c3-pace')?.value.trim()||((a.timeEstimated?'≈ ':'')+fmtPace(a.movingTime,dist)),
      elevation:'↑ '+Math.round(a.elevationGain||0)+' m',
      difficulty:difficulty(a),
      date:$('c3-date')?.value?new Date($('c3-date').value).toLocaleString():new Date(a.startDateLocal||a.startDate||Date.now()).toLocaleString(),
      avgHr:Number.isFinite(a.avgHr)?Math.round(a.avgHr):null,
      // true when the GPX had no <time>: the time/pace shown are estimates
      estimated:!!a.timeEstimated
    };
  }
  function finishCardRows(st){
    const primary=[],grid=[];
    if(statChecked('pace'))primary.push(['AVG PACE',st.pace]);
    if(statChecked('time'))primary.push(['MOVING TIME',st.time]);
    if(statChecked('elevation'))grid.push(['ELEVATION',st.elevation]);
    if(statChecked('difficulty'))grid.push(['DIFFICULTY',st.difficulty]);
    if(st.avgHr!=null)grid.push(['AVG HR',st.avgHr+' bpm']);
    if(statChecked('date'))grid.push(['DATE',st.date]);
    return {primary,grid};
  }
  function showFinish(){
    const o=$('create3d-finish-overlay');if(!o||!state.activity)return;
    const st=finishStats(),rows=finishCardRows(st);
    const set=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
    set('finish-sport',st.sport);
    set('finish-distance',st.distance);
    set('finish-name',st.name);
    const estEl=$('finish-est');if(estEl)estEl.hidden=!st.estimated;
    const hero=$('finish-hero');if(hero)hero.hidden=!st.showDistance;
    const prim=$('finish-primary');
    if(prim){prim.innerHTML=rows.primary.map(x=>`<div class="finish-chip"><small>${x[0]}</small><b>${x[1]}</b></div>`).join('');prim.hidden=!rows.primary.length;}
    const grid=$('finish-stats');
    if(grid){grid.innerHTML=rows.grid.map(x=>`<div class="finish-stat"><small>${x[0]}</small><b>${x[1]}</b></div>`).join('');grid.hidden=!rows.grid.length;}
    o.hidden=false;
  }
  function hideFinish(){const o=$('create3d-finish-overlay');if(o)o.hidden=true;}
  // ─── Canvas twin of the finish card ─────────────────────────────────────
  // Every size derives from `s = W/720`, so the card looks identical at 720p and
  // at the devicePixelRatio-scaled size of the live map canvas. `t` is the
  // appear animation progress (0 → 1) driven by the recording loop.
  const C3_CARD_FONT='Inter, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
  function c3RRect(ctx,x,y,w,h,r){
    const rr=Math.max(0,Math.min(r,Math.min(w,h)/2));
    ctx.beginPath();
    ctx.moveTo(x+rr,y);
    ctx.lineTo(x+w-rr,y);ctx.quadraticCurveTo(x+w,y,x+w,y+rr);
    ctx.lineTo(x+w,y+h-rr);ctx.quadraticCurveTo(x+w,y+h,x+w-rr,y+h);
    ctx.lineTo(x+rr,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-rr);
    ctx.lineTo(x,y+rr);ctx.quadraticCurveTo(x,y,x+rr,y);
    ctx.closePath();
  }
  function c3Text(ctx,text,x,y,size,color,weight,align,spacing,italic){
    ctx.font=`${italic?'italic ':''}${weight||800} ${size}px ${C3_CARD_FONT}`;
    ctx.fillStyle=color;ctx.textAlign=align||'left';ctx.textBaseline='alphabetic';
    const ls=('letterSpacing' in ctx);
    if(ls&&spacing){try{ctx.letterSpacing=spacing+'px';}catch(_){}}
    ctx.fillText(text,x,y);
    if(ls&&spacing){try{ctx.letterSpacing='0px';}catch(_){}}
  }
  function c3Fit(ctx,text,maxW){
    if(ctx.measureText(text).width<=maxW)return text;
    let t=String(text);
    while(t.length>1&&ctx.measureText(t+'…').width>maxW)t=t.slice(0,-1);
    return t+'…';
  }
  function drawFinishCard(ctx,W,H,t){
    if(!(t>0))return;
    const st=finishStats(),rows=finishCardRows(st);
    const s=W/720;
    const p=Math.max(0,Math.min(1,t));
    const ease=1-Math.pow(1-p,3);
    ctx.save();
    ctx.globalAlpha=Math.max(0,Math.min(1,t*1.8));
    const pad=26*s;
    const w=Math.min(W-48*s,560*s);
    const headH=28*s;
    const heroH=st.showDistance?(14*s+70*s+8*s):0;
    const nameH=26*s;
    const primH=rows.primary.length?(52*s+12*s):0;
    const rowH=44*s;
    const gridH=rows.grid.length?Math.ceil(rows.grid.length/2)*rowH:0;
    const footH=44*s;
    const h=pad*2+headH+heroH+nameH+primH+gridH+footH;
    const x=(W-w)/2;
    const y=(H-h)/2+H*0.04+(1-ease)*46*s;
    // body + drop shadow
    ctx.save();
    ctx.shadowColor='rgba(0,0,0,.55)';ctx.shadowBlur=44*s;ctx.shadowOffsetY=20*s;
    c3RRect(ctx,x,y,w,h,26*s);
    const bg=ctx.createLinearGradient(x,y,x,y+h);
    bg.addColorStop(0,'rgba(16,28,48,.95)');bg.addColorStop(1,'rgba(6,12,22,.97)');
    ctx.fillStyle=bg;ctx.fill();
    ctx.restore();
    // clipped accents: top gradient bar + diagonal speed stripes
    ctx.save();
    c3RRect(ctx,x,y,w,h,26*s);ctx.clip();
    const ag=ctx.createLinearGradient(x,y,x+w,y);
    ag.addColorStop(0,'#FC5200');ag.addColorStop(.55,'#FF9A6B');ag.addColorStop(1,'#38BDF8');
    ctx.fillStyle=ag;ctx.fillRect(x,y,w,5*s);
    ctx.globalAlpha=Math.max(0,Math.min(1,t*1.8))*0.10;ctx.fillStyle='#ffffff';
    for(let i=0;i<4;i++){
      const ox=x+w-120*s+i*44*s;
      ctx.beginPath();ctx.moveTo(ox,y);ctx.lineTo(ox+46*s,y);ctx.lineTo(ox+46*s-h,y+h);ctx.lineTo(ox-h,y+h);ctx.closePath();ctx.fill();
    }
    ctx.restore();
    c3RRect(ctx,x,y,w,h,26*s);ctx.strokeStyle='rgba(255,255,255,.13)';ctx.lineWidth=1.5*s;ctx.stroke();
    // ── content
    let cy=y+pad;
    c3Text(ctx,'RUN COMPLETE',x+pad,cy+12*s,11*s,'#FC5200',950,'left',2.2*s);
    ctx.font=`900 ${10*s}px ${C3_CARD_FONT}`;
    const spw=ctx.measureText(st.sport).width+22*s;
    c3RRect(ctx,x+w-pad-spw,cy-2*s,spw,20*s,10*s);
    ctx.fillStyle='rgba(56,189,248,.12)';ctx.fill();
    ctx.strokeStyle='rgba(56,189,248,.28)';ctx.lineWidth=1*s;ctx.stroke();
    c3Text(ctx,st.sport,x+w-pad-spw/2,cy+12*s,10*s,'#7DD3FC',900,'center',1.2*s);
    if(st.estimated){
      // Same "EST" badge as the DOM card: values come from an estimate because
      // the GPX carried no timestamps.
      ctx.font=`900 ${10*s}px ${C3_CARD_FONT}`;
      const ew=ctx.measureText('EST').width+22*s;
      const ex=Math.max(x+pad,x+w-pad-spw-8*s-ew);
      c3RRect(ctx,ex,cy-2*s,ew,20*s,10*s);
      ctx.fillStyle='rgba(251,191,36,.14)';ctx.fill();
      ctx.strokeStyle='rgba(251,191,36,.35)';ctx.lineWidth=1*s;ctx.stroke();
      c3Text(ctx,'EST',ex+ew/2,cy+12*s,10*s,'#FBBF24',900,'center',1.2*s);
    }
    cy+=headH;
    if(st.showDistance){
      c3Text(ctx,'TOTAL DISTANCE',x+pad,cy+9*s,9.5*s,'#7F8EA3',900,'left',1.6*s);
      cy+=14*s;
      ctx.font=`950 ${72*s}px ${C3_CARD_FONT}`;
      c3Text(ctx,st.distance,x+pad,cy+58*s,72*s,'#FFFFFF',950,'left',0);
      const dw=ctx.measureText(st.distance).width;
      c3Text(ctx,st.distanceUnit,x+pad+dw+10*s,cy+58*s,20*s,'#94A3B8',900,'left',1*s);
      cy+=70*s+8*s;
    }
    ctx.font=`700 ${12*s}px ${C3_CARD_FONT}`;
    c3Text(ctx,c3Fit(ctx,st.name,w-pad*2),x+pad,cy+10*s,12*s,'#CBD5E1',700,'left',0);
    cy+=nameH;
    if(rows.primary.length){
      const gap=10*s,cw=(w-pad*2-gap*(rows.primary.length-1))/rows.primary.length;
      rows.primary.forEach((item,i)=>{
        const cx=x+pad+i*(cw+gap);
        c3RRect(ctx,cx,cy,cw,52*s,14*s);
        const cg=ctx.createLinearGradient(cx,cy,cx+cw,cy+52*s);
        if(i===0){cg.addColorStop(0,'rgba(252,82,0,.18)');cg.addColorStop(1,'rgba(252,82,0,.03)');}
        else{cg.addColorStop(0,'rgba(255,255,255,.08)');cg.addColorStop(1,'rgba(255,255,255,.02)');}
        ctx.fillStyle=cg;ctx.fill();
        ctx.strokeStyle=i===0?'rgba(252,82,0,.34)':'rgba(255,255,255,.10)';ctx.lineWidth=1*s;ctx.stroke();
        c3Text(ctx,item[0],cx+13*s,cy+19*s,9*s,'#94A3B8',900,'left',1.4*s);
        c3Text(ctx,item[1],cx+13*s,cy+42*s,21*s,i===0?'#FF9A6B':'#FFFFFF',950,'left',0);
      });
      cy+=52*s+12*s;
    }
    if(rows.grid.length){
      const gap=10*s,cw=(w-pad*2-gap)/2;
      rows.grid.forEach((item,i)=>{
        const cx=x+pad+(i%2)*(cw+gap),ry=cy+Math.floor(i/2)*rowH;
        c3RRect(ctx,cx,ry,cw,rowH-8*s,11*s);
        ctx.fillStyle='rgba(255,255,255,.045)';ctx.fill();
        c3Text(ctx,item[0],cx+12*s,ry+16*s,8.5*s,'#7F8EA3',900,'left',1.3*s);
        ctx.font=`800 ${14*s}px ${C3_CARD_FONT}`;
        c3Text(ctx,c3Fit(ctx,item[1],cw-24*s),cx+12*s,ry+33*s,14*s,'#E2E8F0',800,'left',0);
      });
      cy+=gridH;
    }
    const fy=y+h-pad-2*s;
    ctx.beginPath();ctx.arc(x+pad+4*s,fy-4*s,4*s,0,Math.PI*2);ctx.fillStyle='#FC5200';ctx.fill();
    c3Text(ctx,'RUNNERSHUB',x+pad+16*s,fy,10.5*s,'rgba(255,255,255,.62)',950,'left',2.4*s);
    ctx.restore();
  }
  function normalizeImportedActivity(a){if(!a||!a.summaryPolyline)throw new Error('The activity does not expose a usable route.');return a;}
  async function loadPublicActivity(){
    const input=$('create3d-url').value.trim();
    if(!input)return setStatus('Paste a public Strava activity link first.','err');
    // Layered strategy: connected athlete → official Strava API (no scraping,
    // no 403, works for private activities). Not connected → public page. The
    // API can only read the connected athlete's own activities, so if it fails
    // (someone else's link) we still fall back to the public page.
    setStatus(state.connected?'Reading activity from Strava…':'Reading public activity page…');
    $('create3d-load-btn').disabled=true;
    window.__PERF__.showStats=false;
    try{
      let a=null;
      if(state.connected){
        try{
          a=normalizeImportedActivity(await callApi('stravaImportActivity',{runnerId:getRunnerId(),url:input}));
        }catch(apiErr){
          setStatus('Not available via your Strava account — trying the public page…');
          a=normalizeImportedActivity(await callApi('stravaPublicImportActivity',{runnerId:getRunnerId(),url:input}));
        }
      }else{
        a=normalizeImportedActivity(await callApi('stravaPublicImportActivity',{runnerId:getRunnerId(),url:input}));
      }
      state.activity=a;state.gpxPoints=null;state.route=decodePolyline(a.summaryPolyline);
      if(state.route.length<2)throw new Error('The public activity did not contain enough route points.');
      $('create3d-workspace').hidden=false;renderStats();
      await initMap(state.route);
      window.showC3Success?.('✓ Activity loaded successfully');
      setStatus((a.source==='strava'?'Strava activity loaded':'Public activity loaded')+'. 3D terrain preview is ready.','ok');
      setTimeout(()=>state.map?.resize(),100);
    }catch(e){
      c3HideLoading();
      window.showC3Error?.('Activity Loading Failed',e.message||'Could not read activity.','');
      setStatus(e.message||'Could not read the public activity. Try uploading the GPX export instead.','err');
    }finally{$('create3d-load-btn').disabled=false;}
  }
  // ─── GPX import: single files, multiple files, and Strava bulk-export ZIP ──
  // The whole flow is 100% free and runs locally — no Strava API, no account.
  // Strava users can get a ZIP of every activity from
  // Settings → My Account → Download or Delete Your Account → Download.

  // Minimal ZIP reader (stored + deflate entries) using the browser's
  // DecompressionStream, so no third-party library is needed.
  async function unzipGpxEntries(buffer){
    const u8=new Uint8Array(buffer), dv=new DataView(buffer);
    let eocd=-1;
    for(let i=u8.length-22;i>=0 && i>=u8.length-22-65558;i--){
      if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; }
    }
    if(eocd<0) throw new Error('That ZIP could not be read (not a valid archive).');
    const count=dv.getUint16(eocd+10,true);
    let off=dv.getUint32(eocd+16,true);
    const out=[];
    for(let n=0;n<count;n++){
      if(off+46>u8.length || dv.getUint32(off,true)!==0x02014b50) break;
      const method=dv.getUint16(off+10,true);
      const compSize=dv.getUint32(off+20,true);
      const nameLen=dv.getUint16(off+28,true);
      const extraLen=dv.getUint16(off+30,true);
      const commentLen=dv.getUint16(off+32,true);
      const localOff=dv.getUint32(off+42,true);
      const rawName=new TextDecoder().decode(u8.subarray(off+46,off+46+nameLen));
      off+=46+nameLen+extraLen+commentLen;
      if(!/\.gpx$/i.test(rawName)) continue;
      const lNameLen=dv.getUint16(localOff+26,true);
      const lExtraLen=dv.getUint16(localOff+28,true);
      const start=localOff+30+lNameLen+lExtraLen;
      const data=u8.subarray(start,Math.min(start+compSize,u8.length));
      let text;
      if(method===0){ text=new TextDecoder().decode(data); }
      else if(method===8){
        if(typeof DecompressionStream==='undefined'){
          throw new Error('This browser cannot unzip files. Please unzip the export and upload the .gpx files directly.');
        }
        const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        text=await new Response(stream).text();
      } else { continue; }   // unsupported compression — skip
      out.push({name:rawName.split('/').pop(),text});
    }
    return out;
  }

  function renderGpxPicker(list){
    const box=$('create3d-gpx-list');
    if(!box) return;
    box.innerHTML='';
    const head=document.createElement('div');
    head.className='c3-gpx-head';
    head.textContent=`${list.length} activities found — choose one:`;
    box.appendChild(head);
    list.forEach((f,idx)=>{
      const b=document.createElement('button');
      b.type='button'; b.className='c3-gpx-item';
      const name=document.createElement('b'); name.textContent=f.name.replace(/\.gpx$/i,'');
      const meta=document.createElement('span');
      meta.textContent=(f.text.length/1024).toFixed(0)+' KB';
      b.appendChild(name); b.appendChild(meta);
      b.addEventListener('click',()=>{ box.innerHTML=''; loadGpxText(f.name,f.text); });
      box.appendChild(b);
    });
    setStatus(`${list.length} activities found in the export. Pick one to preview.`,'ok');
  }

  async function handleGpxFiles(fileList){
    const files=[...(fileList||[])];
    if(!files.length) return;
    try{
      setStatus('Reading files…');
      const collected=[];
      for(const f of files){
        const lower=String(f.name||'').toLowerCase();
        if(lower.endsWith('.zip')){
          setStatus(`Unzipping ${f.name}…`);
          const entries=await unzipGpxEntries(await f.arrayBuffer());
          if(!entries.length) throw new Error(`No .gpx files found inside ${f.name}.`);
          collected.push(...entries);
        }else{
          collected.push({name:f.name||'activity.gpx',text:await f.text()});
        }
      }
      if(!collected.length){ setStatus('No GPX files found.','err'); return; }
      // Strava names exports by activity id — sort newest first.
      collected.sort((a,b)=>{
        const na=Number((b.name.match(/(\d+)/)||[])[1]||0), nb=Number((a.name.match(/(\d+)/)||[])[1]||0);
        return na-nb;
      });
      if(collected.length===1){ await loadGpxText(collected[0].name,collected[0].text); return; }
      renderGpxPicker(collected);
    }catch(e){
      c3HideLoading();
      window.showC3Error?.('Import failed',e.message,e.message);
      setStatus(e.message||'Could not read the files.','err');
    }
  }

  async function loadGpxFile(file){
    if(!file)return;
    await loadGpxText(file.name, await file.text());
  }
  // ─── "My activities" (legitimate per-user Strava import) ──────────────────
  // Reads ONLY the connected athlete's own activities, so heart rate, precise
  // pace and full-resolution GPS are all allowed here. Strava has no GPX
  // download endpoint, so the server rebuilds a GPX from the streams.
  async function loadMyActivities(){
    const box=$('create3d-my-list'), btn=$('create3d-my-btn');
    if(!box)return;
    if(!state.connected){ setStatus('Connect Strava first to list your own activities.','err'); return; }
    try{
      if(btn)btn.disabled=true;
      setStatus('Loading your Strava activities…');
      const r=await callApi('stravaListActivities',{runnerId:getRunnerId(),opts:{perPage:20}});
      const list=r?.activities||[];
      if(!list.length){ setStatus('No activities with a route were found on your account.','err'); return; }
      box.innerHTML='';
      const head=document.createElement('div');
      head.className='c3-gpx-head';
      head.textContent='Your Strava activities — choose one:';
      box.appendChild(head);
      list.forEach(a=>{
        const b=document.createElement('button');
        b.type='button'; b.className='c3-gpx-item';
        const nm=document.createElement('b');
        nm.textContent=`${a.name||'Activity'} · ${Number(a.distanceKm||0).toFixed(1)} km`;
        const meta=document.createElement('span');
        meta.textContent=String(a.startDateLocal||'').slice(0,10);
        b.appendChild(nm); b.appendChild(meta);
        b.addEventListener('click',()=>{ box.innerHTML=''; pickStravaActivity(a); });
        box.appendChild(b);
      });
      setStatus(`${list.length} activities loaded. Pick one to build the flyover.`,'ok');
    }catch(e){
      c3HideLoading();
      setStatus(e.message||'Could not load your activities.','err');
    }finally{ if(btn)btn.disabled=false; }
  }
  async function pickStravaActivity(a){
    try{
      setStatus('Downloading GPS + heart-rate streams…');
      const r=await callApi('stravaActivityBundle',{runnerId:getRunnerId(),activityId:a.id,activity:a});
      if(!r?.gpx) throw new Error('Strava returned no GPS data for this activity.');
      const extra={
        avgHr:Number.isFinite(r.stats?.avgHr)?r.stats.avgHr:null,
        maxHr:Number.isFinite(r.stats?.maxHr)?r.stats.maxHr:null,
        avgPaceSecPerKm:Number.isFinite(r.stats?.avgPaceSecPerKm)?r.stats.avgPaceSecPerKm:null,
        avgSpeedKmh:Number.isFinite(r.stats?.avgSpeedKmh)?r.stats.avgSpeedKmh:null
      };
      await loadGpxText(`${a.name||'Strava activity'}.gpx`, r.gpx, extra);
    }catch(e){
      c3HideLoading();
      window.showC3Error?.('Strava import failed',e.message,'');
      setStatus(e.message||'Could not import that activity.','err');
    }
  }
  // ─── Pace / heart rate from a plain GPX file ────────────────────────────
  // Yes — pace can be derived from GPX alone: every <trkpt> carries a <time>,
  // so walking the track gives distance and time per segment. We only count the
  // segments where the runner was actually moving (speed above 1.8 km/h), which
  // is the same "moving time" Strava uses, so pauses/traffic lights do not
  // wreck the average pace. Heart rate is optional: it only exists if the
  // exporter wrote Garmin/Strava <extensions> (<gpxtpx:hr>); a bare recorder
  // GPX has no HR at all, and in that case the HR row is simply omitted.
  const C3_MOVING_MIN_MPS=0.5;      // 1.8 km/h — below this counts as stopped
  const C3_MAX_SEGMENT_S=300;       // ignore GPS gaps longer than 5 minutes
  function haversineM(a,b){
    const R=6371000,toRad=v=>v*Math.PI/180;
    const dLat=toRad(b.lat-a.lat),dLon=toRad(b.lon-a.lon);
    const la1=toRad(a.lat),la2=toRad(b.lat);
    const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  function gpxTiming(pts){
    const out={movingTime:0,elapsedTime:0,avgPaceSecPerKm:null,avgHr:null,maxHr:null,hasTime:false};
    const times=pts.map(p=>{const t=Date.parse(p.time);return Number.isFinite(t)?t:null;});
    const valid=times.filter(t=>t!=null);
    if(valid.length>=2){out.elapsedTime=Math.max(0,(Math.max(...valid)-Math.min(...valid))/1000);out.hasTime=true;}
    let moving=0,totalM=0;
    for(let i=1;i<pts.length;i++){
      const dm=haversineM(pts[i-1],pts[i]);
      if(Number.isFinite(dm))totalM+=dm;
      const t0=times[i-1],t1=times[i];
      if(t0==null||t1==null)continue;
      const dt=(t1-t0)/1000;
      if(!(dt>0)||dt>C3_MAX_SEGMENT_S)continue;
      if(dm/dt>=C3_MOVING_MIN_MPS)moving+=dt;
    }
    out.movingTime=moving>0?moving:(out.hasTime?out.elapsedTime:0);
    const km=totalM/1000;
    if(km>0&&out.movingTime>0)out.avgPaceSecPerKm=out.movingTime/km;
    const hrs=pts.map(p=>p.hr).filter(v=>Number.isFinite(v)&&v>0);
    if(hrs.length){
      out.avgHr=Math.round(hrs.reduce((a,b)=>a+b,0)/hrs.length);
      out.maxHr=Math.round(Math.max(...hrs));
    }
    return out;
  }
  // ─── When a GPX carries no timestamps ──────────────────────────────────
  // Route GPX files (uploaded routes, planner exports, this app's own route
  // downloads) hold coordinates — and often nothing else. There is no movement
  // data between points, so a real time/pace CANNOT be derived: there is simply
  // nothing to measure. In that case we estimate: walk the track at an assumed
  // flat pace (default 6:00/km → `threeD.assumedPaceSecPerKm`) and slow it down
  // / speed it up with the gradient (grade-adjusted pace). Every estimated value
  // is marked "≈" so it is never mistaken for real GPS timing.
  function assumedPaceSecPerKm(){
    const v=Number(C().assumedPaceSecPerKm);
    return (Number.isFinite(v)&&v>120&&v<1800)?v:360;
  }
  function estimateMovingTime(pts,paceSecPerKm){
    if(!pts||pts.length<2)return 0;
    // light smoothing first, so GPS altitude noise does not create fake climbs
    const ele=pts.map(p=>Number.isFinite(p.ele)?p.ele:null);
    const sm=ele.map((v,i)=>{
      let s=0,c=0;
      for(let j=Math.max(0,i-2);j<=Math.min(ele.length-1,i+2);j++){if(ele[j]!=null){s+=ele[j];c++;}}
      return c?s/c:null;
    });
    let t=0;
    for(let i=1;i<pts.length;i++){
      const dd=haversineM(pts[i-1],pts[i]);
      if(!(dd>0))continue;
      const grade=(sm[i]!=null&&sm[i-1]!=null)?Math.max(-0.15,Math.min(0.15,(sm[i]-sm[i-1])/dd)):0;
      t+=(dd/1000)*paceSecPerKm*(1+1.15*grade);
    }
    return t;
  }
  async function loadGpxText(fileName, text, extra){
    c3ShowLoading();
    window.__PERF__.showStats=c3Debug();
    window.updatePerfStats?.('gpx_start','GPX parse');
    setStatus('Reading GPX locally…');
    try{
      c3Progress(8,'Reading file','Reading GPX…','parse');
      const doc=new DOMParser().parseFromString(text,'application/xml');
      if(doc.querySelector('parsererror'))throw new Error('Invalid GPX XML.');
      c3Progress(22,'Parsing track','Extracting route points…','parse');
      // Same shared parser as the route-upload flow: <trkpt>/<rtept>/<wpt>,
      // elevation, timestamps and HR/cadence extensions all handled in one place.
      const pts=parseGpxPoints(text,{skipInvalid:true}).points; // tolerate stray points here
      c3Progress(38,'Coordinates valid','Checking coordinate range…','validate');
      if(pts.some(p=>Math.abs(p.lat)>90||Math.abs(p.lon)>180))throw new Error('GPX contains invalid latitude/longitude values.');
      const coords=pts.map(p=>[p.lon,p.lat]);
      state.gpxPoints=pts;
      const dist=distanceKm(coords);
      if(!(dist>0))throw new Error('GPX route distance is zero or invalid.');
      c3Progress(48,'Location valid','Validating route location…','location');
      let elevGain=0;for(let i=1;i<pts.length;i++){const delta=(Number.isFinite(pts[i].ele)&&Number.isFinite(pts[i-1].ele))?pts[i].ele-pts[i-1].ele:0;if(delta>0)elevGain+=delta;}
      const timing=gpxTiming(pts);
      const times=pts.map(p=>Date.parse(p.time)).filter(Number.isFinite);
      // No usable <time> → the GPX has no movement data at all, so estimate the
      // moving time from distance + gradient instead of leaving time/pace blank.
      let timeEstimated=false;
      if(!(timing.hasTime&&timing.movingTime>0)){
        const est=estimateMovingTime(pts,assumedPaceSecPerKm());
        if(est>0){timing.movingTime=est;timing.elapsedTime=est;timing.avgPaceSecPerKm=est/dist;timeEstimated=true;}
      }
      state.activity={id:'gpx-'+Date.now(),name:String(fileName||'GPX activity').replace(/\.gpx$/i,''),sportType:state.routeType||'Trail',distanceKm:dist,movingTime:timing.movingTime,elapsedTime:timing.elapsedTime,elevationGain:elevGain,startDate:times.length?new Date(Math.min(...times)).toISOString():'',startDateLocal:times.length?new Date(Math.min(...times)).toISOString():'',summaryPolyline:'',source:'gpx'};
      state.activity.timeEstimated=timeEstimated;
      state.activity.hasTimeData=!!timing.hasTime;
      state.activity.pointCount=pts.length;
      if(Number.isFinite(timing.avgPaceSecPerKm))state.activity.avgPaceSecPerKm=timing.avgPaceSecPerKm;
      if(timing.avgHr!=null)state.activity.avgHr=timing.avgHr;
      if(timing.maxHr!=null)state.activity.maxHr=timing.maxHr;
      // extra carries heart rate / pace when the GPX came from Strava streams.
      if(extra&&typeof extra==='object'){
        state.activity.avgHr=Number.isFinite(extra.avgHr)?extra.avgHr:null;
        state.activity.maxHr=Number.isFinite(extra.maxHr)?extra.maxHr:null;
        state.activity.avgPaceSecPerKm=Number.isFinite(extra.avgPaceSecPerKm)?extra.avgPaceSecPerKm:null;
        state.activity.avgSpeedKmh=Number.isFinite(extra.avgSpeedKmh)?extra.avgSpeedKmh:null;
      }
      state.route=coords;$('create3d-workspace').hidden=false;renderStats();
      await initMap(coords);
      window.updatePerfStats?.('gpx_done','GPX ready');
      window.showC3Success?.('✓ GPX loaded successfully');
      setStatus('GPX loaded. 3D terrain preview ready.'+(timeEstimated?' · this GPX has no <time> data, so time & pace are estimates (≈)':''),'ok');
      if(timeEstimated){
        const tIn=$('c3-time'),pIn=$('c3-pace');
        if(tIn)tIn.placeholder='≈ '+fmtTime(timing.movingTime);
        if(pIn)pIn.placeholder='≈ '+fmtPace(timing.movingTime,dist);
      }
      setTimeout(()=>state.map?.resize(),100);
      if(c3Debug())document.getElementById('c3-perf-stats')?.classList.remove('hidden');
    }catch(e){
      c3HideLoading();
      window.showC3Error?.('GPX Loading Failed',e.message,()=>loadGpxText(fileName,text));
      setStatus(e.message||'Could not read GPX.','err');
    }
  }
  function gateHtml(text){const g=$('create3d-gate');if(g)g.innerHTML=text;}
  // After a successful export the download stays LOCKED until the runner shares
  // the route (verified server-side). This is the growth loop, kept explicit.
  function renderVideoGate(){
    const v=state.lastVideo;if(!v)return;
    const size=v.sizeMB!=null?v.sizeMB:(v.blob?(v.blob.size/1048576).toFixed(2):'?');
    const secs=v.seconds!=null?v.seconds:'';
    if(state.flyoverShared){
      gateHtml(`✓ Video ready (${size} MB · ${secs}s) · <a class="c3-download-link" href="${v.url}" download="${v.name}">⬇ Download ${v.name}</a><br><button type="button" class="btn btn-ghost btn-sm" id="c3-share-video" style="margin-top:8px">📤 Share video</button>`);
      $('c3-share-video')?.addEventListener('click',shareLastVideo);
    }else{
      gateHtml(`✓ Video ready (${size} MB · ${secs}s) · 🔒 <b>Share this route to unlock the download.</b><br><button type="button" class="btn btn-primary btn-sm" id="c3-unlock-video" style="margin-top:8px">🔓 Share &amp; unlock download</button>`);
      $('c3-unlock-video')?.addEventListener('click',openFlyoverShareGate);
    }
  }
  function openFlyoverShareGate(){
    try{
      if(typeof ShareGate==='undefined')throw new Error('share gate not loaded');
      ShareGate.mode='flyover';
      try{if(typeof setShareGateCopy==='function')setShareGateCopy('flyover');}catch(_){}
      ShareGate.activityId=String(state.activity&&state.activity.id||'');
      ShareGate.routeId='';ShareGate.triggerBtn=null;ShareGate.selectedPlatform=null;
      const ov=document.getElementById('share-gate-overlay');
      if(!ov)throw new Error('share gate markup missing');
      ov.classList.add('show');
      const ss=document.getElementById('sg-share-section');if(ss)ss.style.display='none';
      const vi=document.getElementById('sg-verify-input');if(vi)vi.value='';
      const ve=document.getElementById('sg-verify-error');if(ve)ve.textContent='';
      document.querySelectorAll('.sg-share-btn').forEach(b=>b.classList.remove('sg-done'));
      const pb=document.getElementById('sg-share-reward-btn');if(pb)pb.click();
    }catch(e){
      // No share gate available (e.g. running standalone) — do not lock the file.
      console.warn('[create3d] share gate unavailable:',e&&e.message);
      state.flyoverShared=true;renderVideoGate();
    }
  }
  // Share the freshly recorded clip with the OS share sheet (Web Share API).
  // Falls back to sharing the blob URL, then to a plain download.
  async function shareLastVideo(){
    const v=state.lastVideo;if(!v)return;
    try{
      const file=(typeof File==='function')?new File([v.blob],v.name,{type:v.blob.type||'video/mp4'}):null;
      if(file&&navigator.canShare&&navigator.canShare({files:[file]})){
        await navigator.share({files:[file],title:'RunnersHub 3D Flyover',text:'My run in 3D'});
        return;
      }
      if(navigator.share){
        await navigator.share({title:'RunnersHub 3D Flyover',text:'My run in 3D',url:v.url});
        return;
      }
      const a=document.createElement('a');a.href=v.url;a.download=v.name;document.body.appendChild(a);a.click();a.remove();
    }catch(_){/* user cancelled or unsupported — nothing to do */}
  }
  async function generate(){
    if(!state.activity)return;
    const cfg=C().export||{};
    const enabled=cfg.enabled!==false && C().exportEnabled!==false;
    const cost=Number(cfg.pointsCost ?? C().pointsCost ?? 0);
    if(!enabled){$('create3d-gate').textContent='Video export is disabled in configuration.';return;}
    if(state.recording)return;
    const btn=$('create3d-generate-btn');if(btn)btn.disabled=true;
    // Points are real value: never spend them on a single click. Show the price
    // and the balance, and require an explicit confirmation.
    if(cost>0&&!state.generateConfirmed){
      const bal=Number(window.Rewards&&window.Rewards.wallet?window.Rewards.wallet.points:NaN);
      if(Number.isFinite(bal)&&bal<cost){
        gateHtml(`You need <b>${cost} points</b> to generate this video. You have <b>${bal}</b>.`);
        if(btn)btn.disabled=false;
        return;
      }
      gateHtml(`Generating this video costs <b>${cost} points</b>${Number.isFinite(bal)?` · balance: ${bal}`:''}.<br><button type="button" class="btn btn-primary btn-sm" id="c3-confirm-generate">✅ Confirm &amp; generate</button> <button type="button" class="btn btn-ghost btn-sm" id="c3-cancel-generate">Cancel</button>`);
      $('c3-confirm-generate')?.addEventListener('click',()=>{state.generateConfirmed=true;generate();});
      $('c3-cancel-generate')?.addEventListener('click',()=>{state.generateConfirmed=false;$('create3d-gate').textContent='Cancelled — no points were spent.';});
      if(btn)btn.disabled=false;
      return;
    }
    state.generateConfirmed=false;
    $('create3d-gate').textContent=cost===0?'Preparing test video export…':'Preparing video export…';
    let serverReady=false,serverMsg='';
    try{
      const r=await callApi('prepare3dFlyover',{runnerId:getRunnerId(),activityId:String(state.activity.id),pointsCost:cost,previewProgress:state.previewProgress||0,stats:customStats()});
      serverReady=!!r?.ready; serverMsg=r?.message||'';
    }catch(e){serverMsg=e.message||'Could not reach the video renderer.';}
    if(serverReady){
      $('create3d-gate').textContent=cost===0?'✓ Test video generation accepted — 0 points charged.':`✓ Video generation accepted — ${cost} points charged.`;
      if(btn)btn.disabled=false;
      return;
    }
    if(cost>0){
      $('create3d-gate').textContent=serverMsg||'Final renderer is not configured.';
      if(btn)btn.disabled=false;
      return;
    }
    // Test mode (pointsCost = 0) with no cloud renderer: don't fake an MP4 —
    // record a real video of the live 3D preview in the browser instead.
    state.recording=true;
    $('create3d-gate').textContent='Renderer not configured — recording a local test video from your preview…';
    try{
      const out=await recordPreviewToVideo();
      if(!out?.ok){$('create3d-gate').textContent=out?.error||'Could not record the test video.';}
      else{
        if(state.lastVideo){state.lastVideo.sizeMB=out.sizeMB;state.lastVideo.seconds=out.seconds;}
        state.flyoverShared=false;   // download stays locked until a verified share
        renderVideoGate();
      }
    }catch(e){$('create3d-gate').textContent='Test video recording failed: '+(e.message||'unexpected error');}
    finally{state.recording=false;if(btn)btn.disabled=false;}
  }
  // ─── HUD: live elevation profile + dynamic pace ─────────────────────────
  // One data model, two targets: the on-page overlay canvas (what you see while
  // previewing) and the video frames (what gets exported). Both are painted by
  // drawHud(), so the exported video always matches the preview.
  const C3_HUD_SAMPLES=170;
  function gpxCumulative(pts){
    const cd=[0];let t=0;
    for(let i=1;i<pts.length;i++){t+=haversineM(pts[i-1],pts[i]);cd.push(t);}
    return {cd,total:t};
  }
  function c3FillSmooth(arr){
    let last=null;
    for(let i=0;i<arr.length;i++){const v=arr[i];if(Number.isFinite(v))last=v;else if(last!=null)arr[i]=last;}
    if(last==null)return false;
    for(let i=0;i<arr.length;i++)if(!Number.isFinite(arr[i]))arr[i]=last;
    for(let k=0;k<2;k++){
      const prev=arr.slice();
      for(let i=1;i<arr.length-1;i++)arr[i]=(prev[i-1]+2*prev[i]+prev[i+1])/4;
    }
    return true;
  }
  function indexAtDistance(cd,d){
    if(!(d>0))return 0;
    if(d>=cd[cd.length-1])return cd.length-1;
    let lo=0,hi=cd.length-1;
    while(lo<hi){const m=(lo+hi)>>1;if(cd[m]<d)lo=m+1;else hi=m;}
    return lo;
  }
  function buildHudModels(){
    state.elevModel=null;state.paceModel=null;
    state.hudTotalM=Number(state.activity?.distanceKm||0)*1000;
    if(!state.route||state.route.length<2)return;
    const n=C3_HUD_SAMPLES;
    const model=state.markerModel||(state.markerModel=buildLinearModel(state.route));
    const gpx=Array.isArray(state.gpxPoints)&&state.gpxPoints.length>1?state.gpxPoints:null;
    if(gpx){
      const {cd,total}=gpxCumulative(gpx);
      const T=total>0?total:(model.total||state.hudTotalM);
      state.hudTotalM=T;
      // Elevation: bucket-average the GPX <ele> values.
      const ele=new Array(n);
      for(let i=0;i<n;i++){
        const a=indexAtDistance(cd,T*i/n),b=Math.max(a+1,indexAtDistance(cd,T*(i+1)/n));
        let sum=0,c=0;
        for(let j=a;j<b&&j<gpx.length;j++){const z=Number(gpx[j]&&gpx[j].ele);if(Number.isFinite(z)){sum+=z;c++;}}
        ele[i]=c?sum/c:null;
      }
      if(c3FillSmooth(ele))state.elevModel=ele.map((z,i)=>({d:T*i/(n-1),z}));
      // Pace: sec/km over a sliding window (~250 m), computed from the GPX
      // timestamps the same way a watch does — stopped segments are ignored so
      // the number never collapses to zero at a traffic light.
      const times=gpx.map(p=>{const t=Date.parse(p&&p.time);return Number.isFinite(t)?t:null;});
      if(times.filter(t=>t!=null).length>=2){
        const half=Math.max(125,T*0.02),pace=new Array(n);
        for(let i=0;i<n;i++){
          const d=T*(i+0.5)/n;
          const a=indexAtDistance(cd,d-half),b=Math.max(a+1,indexAtDistance(cd,d+half));
          // Sum only the MOVING segments inside the window: a 30 s stop in the
          // middle of the window must not drag the displayed pace down.
          let dd=0,dt=0;
          for(let j=a+1;j<=b;j++){
            const ta=times[j-1],tb=times[j];
            if(ta==null||tb==null)continue;
            const seg=(tb-ta)/1000,sd=cd[j]-cd[j-1];
            if(!(seg>0&&seg<C3_MAX_SEGMENT_S))continue;
            if(sd/seg>=C3_MOVING_MIN_MPS){dd+=sd;dt+=seg;}
          }
          pace[i]=(dt>0&&dd>50)?(dt/(dd/1000)):null;
        }
        if(c3FillSmooth(pace))state.paceModel=pace.map((v,i)=>({d:T*i/(n-1),pace:v}));
      }
    }
    if(!state.elevModel&&state.map&&typeof state.map.queryTerrainElevation==='function'&&model.total>0){
      // Polyline-only imports carry no <ele>: sample the loaded DEM instead.
      const T=model.total,ele=new Array(n);
      for(let i=0;i<n;i++){
        const p=linearPoint(model,T*i/(n-1));let z=null;
        try{const q=state.map.queryTerrainElevation(p,{exaggerated:false});if(Number.isFinite(q))z=q;}catch(_){}
        ele[i]=z;
      }
      if(c3FillSmooth(ele)){state.elevModel=ele.map((z,i)=>({d:T*i/(n-1),z}));state.hudTotalM=T;}
    }
    state.paceEstimated=false;   // set again below when the pace is an estimate
    if(!state.paceModel){
      const a=state.activity||{};
      const avg=(Number(a.movingTime)>0&&Number(a.distanceKm)>0)?a.movingTime/a.distanceKm:null;
      if(Number.isFinite(avg)&&avg>0&&state.elevModel&&state.elevModel.length>2){
        // No usable timestamps (typical for polyline imports and for GPX exports
        // that drop <time>): estimate a LIVE pace instead of a flat number, using
        // grade-adjusted pace — slower uphill, faster downhill — renormalised so
        // its mean equals the activity's real average pace.
        state.paceEstimated=true;
        const raw=state.elevModel.map((e,i)=>{
          const nxt=state.elevModel[Math.min(state.elevModel.length-1,i+1)];
          const dd=Math.max(1,nxt.d-e.d);
          const grade=Math.max(-0.15,Math.min(0.15,(nxt.z-e.z)/dd));
          return {d:e.d,pace:avg*(1+1.15*grade)};
        });
        const mean=raw.reduce((sum,r)=>sum+r.pace,0)/raw.length;
        const k=mean>0?avg/mean:1;
        state.paceModel=raw.map(r=>({d:r.d,pace:r.pace*k}));
      }else if(Number.isFinite(avg)&&avg>0){
        state.paceEstimated=true;
        state.paceModel=[{d:0,pace:avg},{d:state.hudTotalM||1,pace:avg}];
      }
    }
  }
  function hudSampleAt(model,d,key){
    if(!model||!model.length)return null;
    if(!(d>0))return model[0][key];
    const last=model[model.length-1];
    if(d>=last.d)return last[key];
    let lo=0,hi=model.length-1;
    while(lo<hi){const m=(lo+hi)>>1;if(model[m].d<d)lo=m+1;else hi=m;}
    const b=model[lo],a=model[lo-1]||b,va=a[key],vb=b[key];
    if(!Number.isFinite(va)||!Number.isFinite(vb))return Number.isFinite(vb)?vb:(Number.isFinite(va)?va:null);
    const t=(d-a.d)/Math.max(1e-6,b.d-a.d);
    return va+(vb-va)*t;
  }
  function fmtPaceShort(secPerKm){
    if(!Number.isFinite(secPerKm)||secPerKm<=0)return '—';
    const t=Math.round(secPerKm);
    return Math.floor(t/60)+':'+String(t%60).padStart(2,'0');
  }
  // Bottom elevation profile (gradasi: makin ke bawah makin pekat) + pace
  // dinamis di sisi kanan, both following the runner dot.
  function drawHud(ctx,W,H,progress,alpha,showPace){
    const s=W/720;
    const p=Math.max(0,Math.min(1,progress||0));
    const total=state.hudTotalM||0;
    const d=total*p;
    ctx.save();
    ctx.globalAlpha=Math.max(0,Math.min(1,alpha==null?1:alpha));
    const padX=26*s;
    // The elevation panel covers the bottom 20% of the frame, so the ridge and
    // the read-outs stay legible on a phone-sized export.
    const ph=Math.round(H*0.20);
    // Safe zone: Instagram/TikTok/Reels draw captions, buttons and the comment
    // bar over the bottom of a video, so the whole HUD is lifted above it
    // (config.js → threeD.hudBottomOffset, fraction of the frame height).
    const bottomPad=Math.round(H*Math.max(0,Math.min(0.22,Number(C().hudBottomOffset??0.10)||0)));
    const panelTop=Math.max(0,H-bottomPad-ph);
    const sy=Math.max(0,Math.round(panelTop-ph*0.34));
    const scrim=ctx.createLinearGradient(0,sy,0,H);
    scrim.addColorStop(0,'rgba(4,10,20,0)');
    scrim.addColorStop(.45,'rgba(4,10,20,.52)');
    scrim.addColorStop(1,'rgba(4,10,20,.94)');
    ctx.fillStyle=scrim;ctx.fillRect(0,sy,W,H-sy);
    ctx.strokeStyle='rgba(255,255,255,.08)';ctx.lineWidth=1*s;
    ctx.beginPath();ctx.moveTo(0,panelTop+.5*s);ctx.lineTo(W,panelTop+.5*s);ctx.stroke();
    const m=state.elevModel;
    if(m&&m.length>1&&total>0){
      const topY=panelTop+Math.round(46*s), baseY=H-bottomPad-Math.round(60*s);
      const areaH=Math.max(24*s,baseY-topY);
      let mn=Infinity,mx=-Infinity;
      for(const e of m){if(Number.isFinite(e.z)){mn=Math.min(mn,e.z);mx=Math.max(mx,e.z);}}
      if(!(mx-mn>1))mx=mn+1;
      const px=dd=>padX+(W-padX*2)*Math.max(0,Math.min(1,dd/total));
      const pz=z=>baseY-areaH*((z-mn)/(mx-mn));
      const pts=m.map(e=>[px(e.d),pz(Number.isFinite(e.z)?e.z:mn)]);
      const cutX=px(d);
      // split the ridge at the runner so travelled / remaining can differ
      const left=[],right=[];
      for(let i=0;i<pts.length;i++){
        const x=pts[i][0],y=pts[i][1];
        if(x<=cutX){
          left.push([x,y]);
          if(i+1<pts.length&&pts[i+1][0]>cutX){
            const t=(cutX-x)/Math.max(1e-6,pts[i+1][0]-x);
            const iy=y+(pts[i+1][1]-y)*t;
            left.push([cutX,iy]);right.push([cutX,iy]);
          }
        }else right.push([x,y]);
      }
      if(!right.length)right.push([cutX,baseY]);
      const fillArea=(arr,stops)=>{
        if(arr.length<2)return;
        ctx.save();
        ctx.beginPath();ctx.moveTo(arr[0][0],arr[0][1]);
        for(let i=1;i<arr.length;i++)ctx.lineTo(arr[i][0],arr[i][1]);
        ctx.lineTo(arr[arr.length-1][0],baseY);ctx.lineTo(arr[0][0],baseY);ctx.closePath();ctx.clip();
        const g=ctx.createLinearGradient(0,topY,0,baseY);
        stops.forEach((st,i)=>g.addColorStop(i/(stops.length-1),st));
        ctx.fillStyle=g;ctx.fillRect(0,topY,W,baseY-topY);
        ctx.restore();
      };
      // remaining: neutral
      fillArea(right,['rgba(148,163,184,.05)','rgba(148,163,184,.20)','rgba(148,163,184,.38)']);
      // travelled: orange, denser toward the bottom
      fillArea(left,['rgba(252,82,0,.10)','rgba(252,82,0,.42)','rgba(252,82,0,.95)']);
      // ridge
      const strokeRidge=(arr,color,w)=>{
        if(arr.length<2)return;
        ctx.beginPath();ctx.moveTo(arr[0][0],arr[0][1]);
        for(let i=1;i<arr.length;i++)ctx.lineTo(arr[i][0],arr[i][1]);
        ctx.strokeStyle=color;ctx.lineWidth=w;ctx.lineJoin='round';ctx.stroke();
      };
      strokeRidge(right,'rgba(255,255,255,.22)',2*s);
      strokeRidge(left,'rgba(255,255,255,.92)',2.4*s);
      ctx.strokeStyle='rgba(255,255,255,.10)';ctx.lineWidth=1*s;
      ctx.beginPath();ctx.moveTo(padX,baseY+.5*s);ctx.lineTo(W-padX,baseY+.5*s);ctx.stroke();
      // runner dot on the profile
      const zNow=hudSampleAt(m,d,'z');
      const dotY=pz(Number.isFinite(zNow)?zNow:mn);
      ctx.strokeStyle='rgba(252,82,0,.45)';ctx.lineWidth=1.5*s;
      ctx.beginPath();ctx.moveTo(cutX,dotY);ctx.lineTo(cutX,baseY);ctx.stroke();
      ctx.save();
      ctx.shadowColor='rgba(252,82,0,.9)';ctx.shadowBlur=16*s;
      ctx.beginPath();ctx.arc(cutX,dotY,6.5*s,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
      ctx.restore();
      ctx.beginPath();ctx.arc(cutX,dotY,11.5*s,0,Math.PI*2);ctx.strokeStyle='rgba(252,82,0,.9)';ctx.lineWidth=2.4*s;ctx.stroke();
      // faint gridlines give the bigger panel some depth
      ctx.strokeStyle='rgba(255,255,255,.06)';ctx.lineWidth=1*s;
      for(let i=1;i<3;i++){const gy=topY+areaH*(i/3);ctx.beginPath();ctx.moveTo(padX,gy+.5*s);ctx.lineTo(W-padX,gy+.5*s);ctx.stroke();}
      c3Text(ctx,'ELEVATION PROFILE',padX,panelTop+27*s,12*s,'rgba(226,232,240,.62)',900,'left',2.4*s);
      c3Text(ctx,Math.round(mx)+' m',W-padX,panelTop+27*s,12*s,'rgba(226,232,240,.45)',900,'right',1.4*s);
      c3Text(ctx,Math.round(mn)+' m',W-padX,baseY+19*s,12*s,'rgba(226,232,240,.45)',900,'right',1.4*s);
      if(Number.isFinite(zNow))c3Text(ctx,'↑ '+Math.round(zNow)+' m',padX,H-bottomPad-26*s,24*s,'#FFFFFF',950,'left',0);
      c3Text(ctx,(d/1000).toFixed(2)+' / '+(total/1000).toFixed(2)+' KM',W-padX,H-bottomPad-26*s,17*s,'rgba(226,232,240,.85)',900,'right',1.2*s);
    }
    // ── live pace: right edge, vertically centred between the top margin and
    // the elevation panel. Always rendered (shows "—" if there is no data yet).
    if(showPace!==false&&total>0){
      const paceVal=hudSampleAt(state.paceModel,d,'pace');
      const txt=fmtPaceShort(Number.isFinite(paceVal)?paceVal:NaN);
      const cx=W-padX;
      ctx.font=`italic 900 ${Math.round(56*s)}px ${C3_CARD_FONT}`;
      const tw=ctx.measureText(txt).width;
      const bw=Math.max(tw+58*s,Math.round(164*s)), bh=Math.round(96*s);
      const bx=cx-bw;
      const bandTop=Math.round(H*0.10), bandBottom=panelTop-Math.round(18*s);
      const by=Math.max(bandTop,Math.min(bandBottom-bh,Math.round((bandTop+bandBottom)/2-bh/2)));
      c3RRect(ctx,bx,by,bw,bh,18*s);
      ctx.fillStyle='rgba(6,12,22,.42)';ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,.10)';ctx.lineWidth=1*s;ctx.stroke();
      c3Text(ctx,state.paceEstimated?'PACE · EST':'PACE',cx-16*s,by+23*s,10*s,'#94A3B8',900,'right',2.2*s);
      ctx.save();
      ctx.shadowColor='rgba(252,82,0,.55)';ctx.shadowBlur=18*s;
      c3Text(ctx,txt,cx-16*s,by+bh-27*s,56*s,'#FFFFFF',900,'right',0,true);
      ctx.restore();
      c3Text(ctx,'/KM',cx-16*s,by+bh-8*s,12*s,'#FF9A6B',900,'right',1.8*s);
    }
    ctx.restore();
  }
  function hudCanvas(){return $('create3d-hud');}
  function paintHudCanvas(){
    const c=hudCanvas();if(!c)return;
    const shell=c.closest('.create3d-map-shell')||c.parentElement;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const w=Math.max(1,Math.round((shell&&shell.clientWidth||0)*dpr));
    const h=Math.max(1,Math.round((shell&&shell.clientHeight||0)*dpr));
    if(w<2||h<2)return;
    if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
    const ctx=c.getContext('2d');if(!ctx)return;
    ctx.clearRect(0,0,w,h);
    drawHud(ctx,w,h,state.hudProgress!=null?state.hudProgress:(state.previewProgress||0),1);
  }
  function clearHudCanvas(){
    const c=hudCanvas();if(!c)return;
    const ctx=c.getContext('2d');if(ctx)ctx.clearRect(0,0,c.width,c.height);
  }
  async function recordPreviewToVideo(){
    if(!state.map||!state.route?.length)return {ok:false,error:'Load a route first, then try Generate again.'};
    const mapCanvas=state.map.getCanvas?.();
    if(!mapCanvas||typeof mapCanvas.captureStream!=='function'||typeof MediaRecorder==='undefined'){
      return {ok:false,error:'This browser cannot capture the 3D canvas. Use Google Chrome (hardware acceleration on) to record a test video.'};
    }
    const fps=Math.max(10,Math.min(30,Number(C().fps||30)));
    // MP4 first (iPhone/Safari friendly), WebM only if H.264 is unavailable.
    const vtype=c3PickVideoType();
    const mime=vtype.mime, vext=vtype.ext;
    // Outro: the statistics card is held on screen at the end of the video.
    const holdMs=Math.max(900,Math.min(6000,Number(C().finishCardMs||1500)));
    // The finish card must be painted INTO the frames: captureStream() only ever
    // sees the WebGL canvas, so a DOM overlay is never captured. We composite the
    // map frame onto a 2D canvas and draw the card on top of it — that 2D canvas
    // is what gets recorded.
    let outCanvas=null,outCtx=null,paintRaf=0,cardAt=0;
    try{
      outCanvas=document.createElement('canvas');
      outCtx=outCanvas.getContext('2d');
      if(!outCtx)throw new Error('2D compositing canvas unavailable');
    }catch(e){return {ok:false,error:'Could not prepare the video canvas: '+(e.message||e)};}
    const shell=document.querySelector('.create3d-map-shell');
    shell?.classList.add('recording');
    // Force the map shell to a 9:16 portrait frame so the captured WebGL canvas
    // matches the export target ratio (1080×1920). Restored in the finally block.
    const savedShellStyle={};
    if(shell){
      const rect=shell.getBoundingClientRect();
      const availH=Math.max(420,Math.min(Math.round(rect.height||680),Math.floor((window.innerHeight||900)*0.88)));
      const host=shell.parentElement;
      const availW=Math.max(240,Math.floor((host&&host.clientWidth||window.innerWidth||900)*0.98));
      // Fit the chosen aspect ratio inside BOTH the available height and width,
      // so 16:9 does not overflow the page while recording.
      const ar=currentAspect();
      let frameH=availH, frameW=Math.round(frameH*ar.w/ar.h);
      if(frameW>availW){frameW=availW;frameH=Math.round(availW*ar.h/ar.w);}
      savedShellStyle.width=shell.style.width;savedShellStyle.height=shell.style.height;
      savedShellStyle.flex=shell.style.flex;savedShellStyle.alignSelf=shell.style.alignSelf;
      savedShellStyle.margin=shell.style.margin;
      shell.style.width=frameW+'px';
      shell.style.height=frameH+'px';
      shell.style.flex='0 0 auto';
      shell.style.alignSelf='center';
      shell.style.margin='0 auto';
    }
    try{state.map.resize();}catch(_){}
    await new Promise(r=>requestAnimationFrame(r));
    await new Promise(r=>requestAnimationFrame(r));
    await new Promise(r=>setTimeout(r,150));
    // Export resolution: aim for the real 1080×1920 target instead of whatever
    // the on-screen canvas happens to be. Never upscale more than 2× (that only
    // produces mush) and never exceed the source when the source is bigger.
    const ar0=currentAspect();
    const targetW=ar0.w>ar0.h?1920:1080;   // landscape 1920 wide, square/portrait 1080
    const srcW=Math.max(2,mapCanvas.width||Math.round(mapCanvas.clientWidth||720));
    const outW=srcW>=targetW?targetW:Math.min(targetW,Math.round(srcW*2));
    outCanvas.width=outW;
    outCanvas.height=Math.round(outW*ar0.h/ar0.w);
    // High-quality scaling keeps the upscale from looking blocky.
    outCtx.imageSmoothingEnabled=true;
    try{outCtx.imageSmoothingQuality='high';}catch(_){}
    // The composite canvas is kept off-screen but ATTACHED to the document: a
    // fully detached canvas is unreliable as a captureStream source in Chromium
    // (it can stop emitting frames, which is what made the export go black).
    outCanvas.setAttribute('aria-hidden','true');
    outCanvas.style.cssText='position:fixed;left:-100000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';
    try{document.body.appendChild(outCanvas);}catch(_){}
    // Capture only AFTER the size is known: a stream taken from the default
    // 300×150 canvas keeps that resolution and the export comes out broken.
    let stream;
    try{stream=outCanvas.captureStream(fps);}catch(e){return {ok:false,error:'Frame capture failed: '+(e.message||e)};}
    // Bitrate decides "jernih vs pecah": the MediaRecorder default (~2.5 Mbps)
    // is far too low, and fast camera motion needs even more. Budget ≈ 0.25 bit
    // per pixel per frame, overridable via threeD.videoBitrate.
    const cfgBitrate=Number(C().videoBitrate);
    const autoBitrate=Math.round(outCanvas.width*outCanvas.height*fps*0.25);
    const bitrate=cfgBitrate>0
      ? Math.max(2000000,Math.min(120000000,cfgBitrate))
      : Math.max(8000000,Math.min(80000000,autoBitrate));
    let rec;
    try{rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:bitrate});}
    catch(_){
      try{rec=new MediaRecorder(stream,{videoBitsPerSecond:bitrate});}
      catch(__){
        try{rec=new MediaRecorder(stream);}
        catch(e){return {ok:false,error:'MediaRecorder could not start: '+(e.message||e)};}
      }
    }
    const chunks=[];
    rec.addEventListener('dataavailable',e=>{if(e.data&&e.data.size)chunks.push(e.data);});
    // Frame source: a <video> fed by the map canvas stream. Going through a
    // MediaStream is immune to the WebGL drawing-buffer caveats that make
    // drawImage(glCanvas) come back blank; direct copy stays as the fallback.
    let srcStream=null,srcVideo=null;
    try{
      srcStream=mapCanvas.captureStream(fps);
      srcVideo=document.createElement('video');
      srcVideo.muted=true;srcVideo.playsInline=true;srcVideo.srcObject=srcStream;
      await new Promise(res=>{
        let done=false;const go=()=>{if(done)return;done=true;res();};
        srcVideo.addEventListener('loadedmetadata',go,{once:true});
        try{srcVideo.play().then(go).catch(go);}catch(_){go();}
        setTimeout(go,1500);
      });
      await new Promise(r=>requestAnimationFrame(r));
    }catch(_){srcVideo=null;}
    buildHudModels();
    // ─── Frame source & pacing ────────────────────────────────────────────
    // The export must contain exactly the frames MapLibre rendered. Routing them
    // through a <video> (decode + presentation queue) is what produced blips on
    // fast camera moves: frames arrive late, twice, or not at all. With
    // preserveDrawingBuffer:true we can copy the WebGL canvas directly, and
    // map.on('render') tells us precisely when a new frame exists.
    let haveFrame=false,frameReady=true,paintStop=false,useFrameMark=false;
    let mapRenderHandler=null,sourceMode='canvas';
    try{
      outCtx.drawImage(mapCanvas,0,0,outCanvas.width,outCanvas.height);
      const px=outCtx.getImageData(Math.floor(outCanvas.width/2),Math.floor(outCanvas.height/2),1,1).data;
      const drewSomething=px[3]!==0||px[0]||px[1]||px[2];
      sourceMode=drewSomething?'canvas':(srcVideo?'video':'canvas');
    }catch(_){sourceMode=srcVideo?'video':'canvas';}
    if(state.map&&typeof state.map.on==='function'){
      try{mapRenderHandler=()=>{frameReady=true;};state.map.on('render',mapRenderHandler);useFrameMark=true;}
      catch(_){mapRenderHandler=null;}
    }
    if(!useFrameMark&&srcVideo&&typeof srcVideo.requestVideoFrameCallback==='function'){
      useFrameMark=true;
      const mark=()=>{frameReady=true;if(!paintStop){try{srcVideo.requestVideoFrameCallback(mark);}catch(_){useFrameMark=false;}}};
      try{srcVideo.requestVideoFrameCallback(mark);}catch(_){useFrameMark=false;}
    }
    const paintFrame=(forceCanvas)=>{
      try{
        const w=outCanvas.width,h=outCanvas.height;
        let drew=false;
        if(forceCanvas||sourceMode==='canvas'){outCtx.drawImage(mapCanvas,0,0,w,h);drew=true;}
        else if(srcVideo&&srcVideo.readyState>=2&&srcVideo.videoWidth>0){outCtx.drawImage(srcVideo,0,0,w,h);drew=true;}
        if(!drew){
          // Nothing new from the camera: keep the previous frame on screen.
          // Never repaint and never switch source — both flash.
          if(!haveFrame){outCtx.fillStyle='#06101d';outCtx.fillRect(0,0,w,h);}
          else return;
        }
        haveFrame=true;
        const prog=state.hudProgress!=null?state.hudProgress:(state.previewProgress||0);
        drawHud(outCtx,w,h,prog,cardAt?0.42:1,!cardAt);
        if(cardAt)drawFinishCard(outCtx,w,h,(performance.now()-cardAt)/650);
      }catch(_){}
    };
    const tick=()=>{
      if(paintStop)return;
      paintRaf=requestAnimationFrame(tick);
      // One composite per rendered frame. During the outro the camera is static,
      // so we keep painting (the statistics card animates) from the live canvas.
      if(!useFrameMark||frameReady){frameReady=false;paintFrame(false);}
      else if(cardAt){paintFrame(true);}
    };
    paintFrame(false);               // paint the first frame right away
    tick();
    try{
      rec.start(1000);
      stopPreview();
      playPreview();
      const maxMs=(Math.max(8,state.durationSeconds)*1000)+3500;
      const t0=performance.now();
      while(state.playing&&(performance.now()-t0)<maxMs){await new Promise(r=>requestAnimationFrame(r));}
      if(state.playing)stopPreview();
      // Keep rolling while the finish card animates in, so the card is part of
      // the exported video instead of only appearing on screen afterwards.
      cardAt=performance.now();
      const t1=performance.now();
      while((performance.now()-t1)<holdMs){await new Promise(r=>requestAnimationFrame(r));}
      try{if(rec.state!=='inactive')rec.stop();}catch(_){}
      await new Promise(res=>{if(rec.state==='inactive'){res();return;}rec.addEventListener('stop',res,{once:true});setTimeout(res,4000);});
      await new Promise(r=>setTimeout(r,300));
      const blob=new Blob(chunks,{type:mime});
      if(!blob.size)return {ok:false,error:'Recording produced no data. Try Chrome with hardware acceleration enabled.'};
      const url=URL.createObjectURL(blob);
      const stamp=String(Date.now()).slice(-10);
      state.lastVideo={blob,url,name:`runnershub-flyover-${stamp}.${vext}`};
      return {ok:true,url,name:state.lastVideo.name,sizeMB:(blob.size/1048576).toFixed(2),seconds:Math.round(state.durationSeconds+(holdMs/1000))};
    }catch(e){return {ok:false,error:'Recording failed: '+(e.message||e)};}
    finally{
      paintStop=true;
      try{if(mapRenderHandler&&state.map&&typeof state.map.off==='function')state.map.off('render',mapRenderHandler);}catch(_){}
      if(paintRaf)cancelAnimationFrame(paintRaf);paintRaf=0;cardAt=0;
      try{if(srcVideo){srcVideo.pause();srcVideo.srcObject=null;}}catch(_){}
      try{if(srcStream&&srcStream.getTracks)srcStream.getTracks().forEach(t=>{try{t.stop();}catch(_){}});}catch(_){}
      try{outCanvas&&outCanvas.remove&&outCanvas.remove();}catch(_){}
      shell?.classList.remove('recording');
      if(shell){
        shell.style.width=savedShellStyle.width;shell.style.height=savedShellStyle.height;
        shell.style.flex=savedShellStyle.flex;shell.style.alignSelf=savedShellStyle.alignSelf;
        shell.style.margin=savedShellStyle.margin;
      }
      try{state.map.resize();}catch(_){}
      try{if(rec.state!=='inactive')rec.stop();}catch(_){}
    }
  }
  function getRewardBalance(){return Number(window.Rewards?.wallet?.points||0);}
  // Each layer is styled in its own guarded try: if one layer is missing the
  // others must still update (a single shared try silently skipped line-color).
  function applyRouteStyle(){
    if(!state.map)return;
    const lw=Number(state.lineWidth)||5, cw=lw*2, col=state.lineColor||'#38BDF8';
    const set=(layer,prop,val)=>{
      if(!state.map.getLayer(layer))return false;
      try{state.map.setPaintProperty(layer,prop,val);return true;}
      catch(e){console.warn('[RunnersHub 3D] paint failed',layer,prop,e?.message);return false;}
    };
    set('activity-route-casing','line-width',cw);
    set('activity-route','line-width',lw);
    set('activity-route','line-color',col);
    updatePlaybackUi();
  }
  function updateLineWidth(){applyRouteStyle();}
  function setLineColor(color){
    state.lineColor=color||'#38BDF8';
    document.querySelectorAll('[data-c3-line-color]').forEach(b=>b.classList.toggle('active',b.dataset.c3LineColor===state.lineColor));
    savePrefs();
    if(state.map)applyRouteStyle();
  }
  function mount(){if(state.mounted){checkConnection();setTimeout(()=>state.map?.resize(),50);return;}state.mounted=true;
    // Preferences must never be able to break the page: if anything goes wrong
    // here every button below would stay unwired.
    try{loadPrefs();applyPrefsToUi();}catch(e){console.warn('[create3d] prefs unavailable:',e?.message);}
    const bind=(id,fn)=>$(id)?.addEventListener('click',fn);bind('create3d-connect-btn',connect);bind('create3d-load-btn',loadPublicActivity);bind('create3d-preview-btn',playPreview);bind('create3d-preview-playback',playPreview);bind('create3d-preview-pause',()=>state.playing?pausePreview():playPreview());bind('create3d-generate-btn',generate);bind('create3d-reset',resetView);bind('create3d-finish-close',hideFinish);bind('create3d-my-btn',loadMyActivities);$('create3d-gpx-file')?.addEventListener('change',e=>handleGpxFiles(e.target.files));const dz=$('create3d-dropzone');if(dz){['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('dragover');}));['dragleave','dragend'].forEach(ev=>dz.addEventListener(ev,()=>dz.classList.remove('dragover')));dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('dragover');handleGpxFiles(e.dataTransfer?.files);});}document.querySelectorAll('[data-c3-map-mode]').forEach(b=>b.addEventListener('click',()=>setMapMode(b.dataset.c3MapMode)));document.querySelectorAll('[data-c3-marker-color]').forEach(b=>b.addEventListener('click',()=>setMarkerColor(b.dataset.c3MarkerColor)));document.querySelectorAll('[data-c3-line-color]').forEach(b=>b.addEventListener('click',()=>setLineColor(b.dataset.c3LineColor)));document.querySelectorAll('[data-c3-ratio]').forEach(b=>b.addEventListener('click',()=>setAspect(b.dataset.c3Ratio)));document.querySelectorAll('[data-c3-route-type]').forEach(b=>b.addEventListener('click',()=>setRouteType(b.dataset.c3RouteType)));$('create3d-preview-scrubber')?.addEventListener('input',e=>setPreviewProgressFromSlider(e.target.value));$('c3-duration')?.addEventListener('input',e=>{state.durationSeconds=Math.max(8,Math.min(60,Number(e.target.value)||20));updatePlaybackUi();savePrefs();});$('c3-speed')?.addEventListener('input',e=>{state.cameraSpeed=Math.max(0.5,Math.min(2,Number(e.target.value)||1));if(state.cameraController)state.cameraController.setSpeed?.(state.cameraSpeed);updatePlaybackUi();savePrefs();});$('c3-line-width')?.addEventListener('input',e=>{state.lineWidth=Math.max(2,Math.min(10,Number(e.target.value)||5));updateLineWidth();savePrefs();});const retryBtn=$('c3-error-retry');if(retryBtn)retryBtn.addEventListener('click',()=>{if(window.__C3_RETRY_CALLBACK__)window.__C3_RETRY_CALLBACK__();});const closeBtn=$('c3-error-close');if(closeBtn)closeBtn.addEventListener('click',()=>{const dialog=$('c3-error-dialog');if(dialog)dialog.classList.add('hidden');});updatePlaybackUi();['c3-time','c3-pace','c3-date'].forEach(id=>$(id)?.addEventListener('input',()=>{if(state.activity&&!state.playing)hideFinish();}));document.querySelectorAll('[data-c3stat]').forEach(i=>i.addEventListener('change',()=>{if(state.activity&&!state.playing)hideFinish();savePrefs();}));const previewBtn=$('create3d-preview-btn');if(previewBtn)previewBtn.disabled=true;checkConnection();hideDomMarker();}
  window.RunnersHubCreate3D={mount,loadActivity:loadPublicActivity,playPreview,pausePreview,resetView,
    refreshGate:renderVideoGate,
    markFlyoverShared:()=>{state.flyoverShared=true;renderVideoGate();}};
  window.addEventListener('hashchange',()=>{
    const hash=(window.location.hash||'').replace('#','');
    if(!hash.startsWith('create3d')&&state.playing) pausePreview();
  });
  if((window.location.hash||'').replace('#','').startsWith('create3d')) setTimeout(mount,0);
})();
