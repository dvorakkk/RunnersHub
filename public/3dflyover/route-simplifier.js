function hav(a,b){const R=6371000,p1=a[1]*Math.PI/180,p2=b[1]*Math.PI/180,dp=(b[1]-a[1])*Math.PI/180,dl=(b[0]-a[0])*Math.PI/180,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
function project(coords){const lat0=coords.reduce((s,p)=>s+p[1],0)/Math.max(1,coords.length)*Math.PI/180,k=Math.max(.15,Math.cos(lat0)),o=coords[0];return coords.map(p=>[(p[0]-o[0])*111320*k,(p[1]-o[1])*110540]);}
function rdp(coords,tol){if(coords.length<=2)return coords.slice();const xy=project(coords),t2=tol*tol;function rec(a,b){let max=0,idx=-1,x1=xy[a][0],y1=xy[a][1],x2=xy[b][0],y2=xy[b][1],dx=x2-x1,dy=y2-y1,l2=dx*dx+dy*dy;for(let i=a+1;i<b;i++){let d;if(!l2)d=(xy[i][0]-x1)**2+(xy[i][1]-y1)**2;else{let t=((xy[i][0]-x1)*dx+(xy[i][1]-y1)*dy)/l2;t=Math.max(0,Math.min(1,t));let qx=x1+t*dx,qy=y1+t*dy;d=(xy[i][0]-qx)**2+(xy[i][1]-qy)**2;}if(d>max){max=d;idx=i;}}if(max>t2){const l=rec(a,idx),r=rec(idx,b);return l.slice(0,-1).concat(r);}return [coords[a],coords[b]];}return rec(0,coords.length-1);}
function resample(coords,step){if(coords.length<2)return coords.slice();const out=[coords[0]];let carry=0,prev=coords[0];for(let i=1;i<coords.length;i++){let cur=coords[i],seg=hav(prev,cur);if(seg<=0){prev=cur;continue;}while(carry+seg>=step){const t=(step-carry)/seg,p=[prev[0]+(cur[0]-prev[0])*t,prev[1]+(cur[1]-prev[1])*t];out.push(p);prev=p;seg=hav(prev,cur);carry=0;}carry+=seg;prev=cur;}if(hav(out.at(-1),coords.at(-1))>1)out.push(coords.at(-1));return out;}
export function simplifyForCamera(coords,o={}){return rdp(resample(coords,Math.max(8,Number(o.resampleMeters??25))),Math.max(3,Number(o.simplifyTolerance??8)));}
export function buildCameraModel(coords,o={}){const path=simplifyForCamera(coords||[],o);const points=[{p:path[0],d:0}];let total=0;for(let i=1;i<path.length;i++){total+=hav(path[i-1],path[i]);points.push({p:path[i],d:total});}return {points,total,rawPoints:(coords||[]).length,cameraPoints:path.length};}
function linear(m,d){const pts=m.points;if(d<=0)return {p:pts[0].p,i:0};if(d>=m.total)return {p:pts.at(-1).p,i:Math.max(0,pts.length-2)};let lo=0,hi=pts.length-1;while(lo<hi){const x=(lo+hi)>>1;if(pts[x].d<d)lo=x+1;else hi=x;}const b=pts[lo],a=pts[lo-1],t=(d-a.d)/Math.max(1e-6,b.d-a.d);return {p:[a.p[0]+(b.p[0]-a.p[0])*t,a.p[1]+(b.p[1]-a.p[1])*t],i:lo-1};}
export function pointAtDistance(m,d){
  const pts=m.points;
  if(pts.length<2)return {p:pts[0]?.p||[0,0],i:0};
  if(pts.length<4)return linear(m,d);
  if(d<=0)return {p:pts[0].p,i:0};
  if(d>=m.total)return {p:pts.at(-1).p,i:pts.length-2};
  let lo=0,hi=pts.length-1;
  while(lo<hi){const x=(lo+hi)>>1;if(pts[x].d<d)lo=x+1;else hi=x;}
  const seg=Math.max(0,Math.min(pts.length-2,lo-1));
  const b=pts[seg],c=pts[seg+1];
  const k=Math.max(0.15,Math.cos(b.p[1]*Math.PI/180));
  const x=q=>q.p[0]*k,y=q=>q.p[1];
  const P1=[x(b),y(b)],P2=[x(c),y(c)];
  const P0=seg>0?[x(pts[seg-1]),y(pts[seg-1])]:[2*P1[0]-P2[0],2*P1[1]-P2[1]];
  const P3=seg+2<pts.length?[x(pts[seg+2]),y(pts[seg+2])]:[2*P2[0]-P1[0],2*P2[1]-P1[1]];
  const dt=Math.max(1e-6,c.d-b.d);
  const t=Math.max(0,Math.min(1,(d-b.d)/dt));
  const t2=t*t,t3=t2*t;
  const d0=seg>0?pts[seg-1].d:2*b.d-c.d;
  const d3=seg+2<pts.length?pts[seg+2].d:2*c.d-b.d;
  const span1=Math.max(1e-6,c.d-d0),span2=Math.max(1e-6,d3-b.d);
  const m1=[(P2[0]-P0[0])/span1,(P2[1]-P0[1])/span1];
  const m2=[(P3[0]-P1[0])/span2,(P3[1]-P1[1])/span2];
  const h00=2*t3-3*t2+1,h10=t3-2*t2+t,h01=-2*t3+3*t2,h11=t3-t2;
  const X=h00*P1[0]+h10*dt*m1[0]+h01*P2[0]+h11*dt*m2[0];
  const Y=h00*P1[1]+h10*dt*m1[1]+h01*P2[1]+h11*dt*m2[1];
  return {p:[X/k,Y],i:seg};
}
export function bearingBetween(a,b){const l1=a[0]*Math.PI/180,l2=b[0]*Math.PI/180,p1=a[1]*Math.PI/180,p2=b[1]*Math.PI/180,y=Math.sin(l2-l1)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(l2-l1);return (Math.atan2(y,x)*180/Math.PI+360)%360;}
export function cameraSample(m,d,o={}){
  const total=m.total||1;
  const maxLook=Math.min(Number(o.lookAheadMeters??260),total*0.18);
  const minLook=Math.min(35,total*0.04);
  const lookAhead=Math.max(minLook,Math.min(maxLook,Number(o.lookAheadMeters??220)));
  const lookBehind=Math.max(minLook*0.5,Math.min(lookAhead*0.45,Number(o.lookBehindMeters??90)));
  const cur=pointAtDistance(m,d);
  const ahead=pointAtDistance(m,Math.min(total,d+lookAhead));
  const behind=pointAtDistance(m,Math.max(0,d-lookBehind));
  const near=pointAtDistance(m,Math.min(total,d+Math.max(20,lookAhead*0.35)));
  const far=pointAtDistance(m,Math.min(total,d+Math.min(total-d,lookAhead*1.3)));
  let targetBearing;
  if(hav(behind.p,ahead.p)>2){
    targetBearing=bearingBetween(behind.p,ahead.p);
  }else if(hav(cur.p,ahead.p)>1){
    targetBearing=bearingBetween(cur.p,ahead.p);
  }else if(hav(behind.p,cur.p)>1){
    targetBearing=bearingBetween(behind.p,cur.p);
  }else{
    targetBearing=0;
  }
  const h1=bearingBetween(behind.p,cur.p);
  const h2=bearingBetween(cur.p,near.p);
  const h3=bearingBetween(near.p,far.p);
  const turn1=Math.abs(((h2-h1+540)%360)-180);
  const turn2=Math.abs(((h3-h2+540)%360)-180);
  const curvature=Math.max(0,Math.min(1,(turn1*0.65+turn2*0.35)/70));
  return {cur,ahead,behind,targetBearing,curvature};
}
