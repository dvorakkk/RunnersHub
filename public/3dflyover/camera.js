const shortest=(a,b)=>((b-a+540)%360)-180;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const hav=(a,b)=>{const R=6371000,p1=a[1]*Math.PI/180,p2=b[1]*Math.PI/180,dp=(b[1]-a[1])*Math.PI/180,dl=(b[0]-a[0])*Math.PI/180,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));};

// Cinematic camera — smooth tracking via damped pursuit + MapLibre easeTo blending.
// Position, heading, pitch, and zoom are each independently smoothed.
// For instant (scrub) mode: jumpTo for zero-latency seek.
// For animate mode:  easeTo with a short transition so MapLibre GPU-interpolates
//   between frames, eliminating the micro-jitter that jumpTo produces at 60 fps.
export function createCinematicCamera({map,config={}}){
  let bearing=null,last=0,pitch=null,zoom=null,center=null,curvSmooth=null,bearingVel=0,speedMultiplier=1;
  const c={
    headingResponse:Number(config.headingResponse??4.5),
    maxTurnPerSecond:Number(config.maxTurnPerSecond??65),
    positionResponse:Number(config.positionResponse??10.0),
    // COROS-style envelope: start tight on the runner, then pull back towards
    // the end so the surrounding environment / whole route becomes visible.
    zoomStart:Number(config.zoomStart??config.zoom??15.2),
    zoomEnd:Number(config.zoomEnd??12.0),
    zoomMin:Number(config.zoomMin??11.6),
    zoomMax:Number(config.zoomMax??15.6),
    pitchStart:Number(config.pitchStart??config.pitch??64),
    pitchEnd:Number(config.pitchEnd??42),
    pitchMin:Number(config.pitchMin??38),
    pitchMax:Number(config.pitchMax??74),
    // easeTo transition duration (ms) — keeps GPU interpolation smooth between ticks
    easeMs:Number(config.easeMs??90)
  };
  return {
    apply(s,{progress=0,curvature=0,animate=true,instant=false,zoom:zoomOverride=null,pitch:pitchOverride=null,snap=false}={}){
      const now=performance.now();
      const dt=(last&&last<now)?Math.max(0.001,Math.min(0.05,(now-last)/1000)):1/60;
      last=now;

      // ── Bearing (heading) ──────────────────────────────────────────────────
      const target=Number.isFinite(s.targetBearing)?s.targetBearing:0;
      if(bearing==null||instant||!animate){
        bearing=target;
        bearingVel=0;
      }else{
        const diff=shortest(bearing,target);
        // Critically-damped spring on the angular difference:
        // velocity tracks the desired rate; max clamp prevents wild swings on long straights.
        const desired=diff*(1-Math.exp(-c.headingResponse*dt));
        const maxStep=c.maxTurnPerSecond*dt;
        const step=clamp(desired,-maxStep,maxStep);
        // Secondary smoothing: blend velocity toward the clamped step (removes micro-oscillation)
        bearingVel+=(step-bearingVel)*(1-Math.exp(-8*dt));
        bearing=(bearing+bearingVel+360)%360;
      }

      // ── Curvature (low-pass, used for adaptive pitch/zoom) ─────────────────
      const rawCurv=clamp(Number(curvature)||0,0,1);
      if(curvSmooth==null||instant||!animate){
        curvSmooth=rawCurv;
      }else{
        curvSmooth+=(rawCurv-curvSmooth)*(1-Math.exp(-5*dt));
      }

      // ── Progress envelope (0 = start/close, 1 = end/wide) ──────────────────
      const pr=clamp(Number(progress)||0,0,1);
      const env=pr*pr*(3-2*pr);   // smoothstep: hold close, then ease outwards

      // ── Pitch ──────────────────────────────────────────────────────────────
      const targetPitch=clamp((pitchOverride??(c.pitchStart+(c.pitchEnd-c.pitchStart)*env))-curvSmooth*7,c.pitchMin,c.pitchMax);
      // snap: set zoom/pitch directly (used by the fast outro — the normal
      // low-pass is slower than the 0.3 s tail and would never finish).
      if(pitch==null||instant||!animate||snap){
        pitch=targetPitch;
      }else{
        pitch+=(targetPitch-pitch)*(1-Math.exp(-3*dt));
      }

      // ── Zoom ───────────────────────────────────────────────────────────────
      const targetZoom=clamp((zoomOverride??(c.zoomStart+(c.zoomEnd-c.zoomStart)*env))-curvSmooth*0.55,c.zoomMin,c.zoomMax);
      if(zoom==null||instant||!animate||snap){
        zoom=targetZoom;
      }else{
        zoom+=(targetZoom-zoom)*(1-Math.exp(-2.5*dt));
      }

      // ── Position (center) ──────────────────────────────────────────────────
      const targetCenter=s.cur?.p||[0,0];
      if(center==null||instant||!animate||hav(center,targetCenter)>120){
        center=[targetCenter[0],targetCenter[1]];
      }else{
        const posAlpha=1-Math.exp(-c.positionResponse*speedMultiplier*dt);
        center[0]+=(targetCenter[0]-center[0])*posAlpha;
        center[1]+=(targetCenter[1]-center[1])*posAlpha;
      }

      // ── Apply to MapLibre ──────────────────────────────────────────────────
      // Apply the smoothed state directly (jumpTo) unless easeMs > 0.
      // Calling easeTo on EVERY frame restarts MapLibre's internal animation from
      // a mid-flight position, so the camera chases a moving target and never
      // quite arrives — that shows up as micro-stutter/blips on fast turns.
      // Our own per-frame damping already shapes the motion, so setting the
      // camera state exactly is both smoother and frame-accurate.
      if(instant||!animate||!(c.easeMs>0)){
        map.jumpTo({center:[center[0],center[1]],zoom,pitch,bearing});
      }else{
        map.easeTo({
          center:[center[0],center[1]],
          zoom,pitch,bearing,
          duration:c.easeMs,
          easing:t=>t  // linear — our own damping already shapes the curve
        });
      }
    },
    setSpeed(speed){
      speedMultiplier=Math.max(0.5,Math.min(2,Number(speed)||1));
    },
    reset(){
      bearing=null;
      pitch=null;
      zoom=null;
      center=null;
      curvSmooth=null;
      bearingVel=0;
      last=0;
      speedMultiplier=1;
    }
  };
}
