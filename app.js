import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";

const canvas=document.getElementById('canvas'), statusEl=document.getElementById('status'), fileInput=document.getElementById('fileInput');
const openBtn=document.getElementById('openBtn'), drop=document.getElementById('drop'), viewer=document.getElementById('viewer');
const partsPanel=document.getElementById('partsPanel'), partsList=document.getElementById('partsList');
const scene=new THREE.Scene(); scene.background=new THREE.Color(0xf0f2f4);
const camera=new THREE.PerspectiveCamera(45,1,.01,200000); camera.position.set(2500,1700,2500);
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.75)); renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.05;
const controls=new OrbitControls(camera,canvas); controls.enableDamping=true; controls.dampingFactor=.08; controls.screenSpacePanning=true; controls.minDistance=.1; controls.maxDistance=200000;
scene.add(new THREE.HemisphereLight(0xffffff,0x777d84,2.2));
const key=new THREE.DirectionalLight(0xffffff,2.8); key.position.set(2500,4000,2500); scene.add(key);
const fill=new THREE.DirectionalLight(0xffffff,1.2); fill.position.set(-2500,1500,-1800); scene.add(fill);
let modelRoot=null, selected=null, partCounter=0, edgeRoot=null, wireMode=false;
const hidden=new Set();
const setStatus=t=>statusEl.textContent=t;
function disposeObject(root){root?.traverse(o=>{if(o.geometry)o.geometry.dispose(); if(o.material){for(const m of(Array.isArray(o.material)?o.material:[o.material]))m.dispose();}})}
function addIndexData(geo){if(geo.index)return geo.index.array; const n=geo.attributes.position.count; return new Uint32Array(Array.from({length:n},(_,i)=>i));}
function triCountForGroup(group,indexCount){const start=group?.start||0; const count=group?.count??indexCount; return Math.floor(Math.min(count,indexCount-start)/3);}
function splitGeometryIntoComponents(src, group){
  const pos=src.attributes.position; if(!pos)return [];
  const indices=addIndexData(src); const start=group?.start||0, count=group?.count??indices.length, end=Math.min(indices.length,start+count); const triN=Math.floor((end-start)/3);
  if(!triN)return [];
  const parent=new Int32Array(pos.count); parent.fill(-1);
  const find=(x)=>{let r=x; while(parent[r]>=0)r=parent[r]; while(x!==r){let n=parent[x]; parent[x]=r; x=n;} return r;};
  const union=(a,b)=>{a=find(a);b=find(b);if(a===b)return;if(parent[a]>parent[b]){const t=a;a=b;b=t;}parent[a]+=parent[b];parent[b]=a;};
  const keyMap=new Map();
  const vkey=i=>{const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);return `${Math.round(x*1e5)}|${Math.round(y*1e5)}|${Math.round(z*1e5)}`};
  for(let t=0;t<triN;t++){
    const a=indices[start+t*3],b=indices[start+t*3+1],c=indices[start+t*3+2];
    for(const v of [a,b,c]){const k=vkey(v); if(keyMap.has(k))union(v,keyMap.get(k)); else keyMap.set(k,v);}
  }
  const comps=new Map();
  for(let t=0;t<triN;t++){const a=indices[start+t*3],b=indices[start+t*3+1],c=indices[start+t*3+2]; const root=find(a); if(!comps.has(root))comps.set(root,[]); comps.get(root).push(a,b,c);}
  const attrs=Object.keys(src.attributes); const out=[];
  for(const inds of comps.values()){
    if(inds.length<3)continue;
    const g=new THREE.BufferGeometry(); const remap=new Map(), newIdx=[];
    const arrays={};
    for(const name of attrs){const a=src.attributes[name]; arrays[name]=[];}
    let ni=0;
    for(const si of inds){let li=remap.get(si); if(li===undefined){li=ni++; remap.set(si,li); for(const name of attrs){const a=src.attributes[name]; const ar=arrays[name]; for(let k=0;k<a.itemSize;k++)ar.push(a.array[si*a.itemSize+k]);}} newIdx.push(li);}
    for(const name of attrs){const a=src.attributes[name]; let arr=arrays[name]; let typed= a.array instanceof Float32Array?new Float32Array(arr):new a.array.constructor(arr); g.setAttribute(name,new THREE.BufferAttribute(typed,a.itemSize,a.normalized));}
    g.setIndex(newIdx); g.computeBoundingBox(); g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}
function splitMesh(mesh){
  const src=mesh.geometry; const groups=src.groups?.length?src.groups:[{start:0,count:src.index?src.index.count:src.attributes.position.count,materialIndex:0}];
  const mats=Array.isArray(mesh.material)?mesh.material:[mesh.material]; const parts=[];
  for(const gr of groups){
    const gs=splitGeometryIntoComponents(src,gr); const mat=mats[gr.materialIndex||0]||mats[0];
    for(const g of gs){const m=new THREE.Mesh(g,mat); m.name=mesh.name; m.userData.partId=++partCounter; parts.push(m);}
  }
  return parts;
}
function splitModel(root){
  const result=new THREE.Group(); result.name='Model';
  root.traverse(o=>{
    if(!o.isMesh)return;
    const parts=splitMesh(o);
    for(const p of parts){p.userData.partName=(o.name&&o.name!=='Object3D'?o.name:'Деталь')+' · '+p.userData.partId; p.castShadow=false;p.receiveShadow=false; result.add(p);}
  });
  return result;
}
function forceTextured(){if(!modelRoot)return; modelRoot.traverse(o=>{if(!o.isMesh)return; for(const m of(Array.isArray(o.material)?o.material:[o.material])){m.wireframe=false;m.transparent=false;m.opacity=1;m.side=THREE.FrontSide;m.depthTest=true;m.depthWrite=true;if(m.map){m.map.colorSpace=THREE.SRGBColorSpace;m.map.needsUpdate=true;}}}); if(edgeRoot){scene.remove(edgeRoot);disposeObject(edgeRoot);edgeRoot=null;}}
function buildExternalEdges(){
  if(edgeRoot){scene.remove(edgeRoot);disposeObject(edgeRoot);}
  edgeRoot=new THREE.Group(); edgeRoot.name='ExternalEdges';
  modelRoot.traverse(o=>{if(!o.isMesh||!o.visible)return; const e=new THREE.EdgesGeometry(o.geometry,20); const mat=new THREE.LineBasicMaterial({color:0x30343a,transparent:true,opacity:.9,depthTest:true,depthWrite:false}); const lines=new THREE.LineSegments(e,mat); lines.renderOrder=2; lines.userData.source=o; edgeRoot.add(lines);});
  scene.add(edgeRoot);
}
function setWire(on){wireMode=on; if(on){modelRoot.traverse(o=>{if(o.isMesh)o.visible=o.visible;}); modelRoot.traverse(o=>{if(o.isMesh)for(const m of(Array.isArray(o.material)?o.material:[o.material])){m.transparent=true;m.opacity=.02;m.depthWrite=true;m.depthTest=true;}}); buildExternalEdges();} else forceTextured(); document.getElementById('wireBtn').classList.toggle('active',on);document.getElementById('textureBtn').classList.toggle('active',!on);}
function centerAndFit(root){const b=new THREE.Box3().setFromObject(root),s=b.getSize(new THREE.Vector3()),c=b.getCenter(new THREE.Vector3());root.position.sub(c);const b2=new THREE.Box3().setFromObject(root),ss=b2.getSize(new THREE.Vector3()),d=Math.max(ss.x,ss.y,ss.z)/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov)/2))*1.25;camera.near=Math.max(.001,Math.max(ss.x,ss.y,ss.z)/100000);camera.far=Math.max(1000,Math.max(ss.x,ss.y,ss.z)*100);camera.position.set(d*.95,d*.65,d*.95);controls.target.set(0,0,0);controls.minDistance=Math.max(.05,Math.max(ss.x,ss.y,ss.z)/10000);controls.maxDistance=Math.max(1000,Math.max(ss.x,ss.y,ss.z)*20);controls.update();}
function rebuildParts(){partsList.innerHTML=''; if(!modelRoot)return; const arr=[];modelRoot.traverse(o=>{if(o.isMesh)arr.push(o)}); arr.forEach((m,i)=>{const row=document.createElement('div');row.className='part';const name=document.createElement('div');name.className='part-name';name.textContent=m.userData.partName||`Деталь ${i+1}`;const focus=document.createElement('button');focus.textContent='Выбрать';focus.onclick=()=>selectPart(m);const hide=document.createElement('button');hide.textContent='Скрыть';hide.onclick=()=>{m.visible=false;hidden.add(m);if(wireMode)buildExternalEdges();};row.append(name,focus,hide);partsList.appendChild(row);});}
function selectPart(m){selected=m;setStatus('Выбрана: '+(m.userData.partName||'деталь')); document.querySelectorAll('.part.selected').forEach(x=>x.classList.remove('selected')); const rows=[...partsList.children]; const idx=[...modelRoot.children].indexOf(m); if(rows[idx])rows[idx].classList.add('selected');}
document.getElementById('showAllBtn').onclick=()=>{modelRoot?.traverse(o=>{if(o.isMesh)o.visible=true});hidden.clear();if(wireMode)buildExternalEdges();};
const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();function pick(e){if(!modelRoot)return;const r=canvas.getBoundingClientRect();pointer.x=((e.clientX-r.left)/r.width)*2-1;pointer.y=-((e.clientY-r.top)/r.height)*2+1;raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObject(modelRoot,true).find(h=>h.object.isMesh&&h.object.visible);if(hit)selectPart(hit.object);}
canvas.addEventListener('pointerdown',e=>canvas._ps={x:e.clientX,y:e.clientY,t:performance.now()});canvas.addEventListener('pointerup',e=>{const s=canvas._ps;if(!s)return;if(Math.hypot(e.clientX-s.x,e.clientY-s.y)<7&&performance.now()-s.t<450)pick(e);canvas._ps=null;});
async function readZip(file){const zip=await JSZip.loadAsync(file),entries=Object.values(zip.files).filter(x=>!x.dir),names=entries.map(x=>x.name.replaceAll('\\','/'));const objName=names.find(n=>/\.obj$/i.test(n));if(!objName)throw Error('В ZIP не найден OBJ');const mtlName=names.find(n=>/\.mtl$/i.test(n));const blobs=new Map();for(const e of entries){const n=e.name.replaceAll('\\','/'),ext=n.split('.').pop().toLowerCase();if(['jpg','jpeg','png','bmp','webp'].includes(ext))blobs.set(n,URL.createObjectURL(await e.async('blob')));}const objText=await zip.file(objName).async('string');let mtlText=mtlName?await zip.file(mtlName).async('string'):null;if(mtlText){const dirs=[mtlName.slice(0,mtlName.lastIndexOf('/')+1),objName.slice(0,objName.lastIndexOf('/')+1),''];mtlText=mtlText.split(/\r?\n/).map(line=>{if(!/^map_Kd\s+/i.test(line))return line;const raw=line.replace(/^map_Kd\s+/i,'').trim().replaceAll('\\','/');const base=raw.split('/').pop();const hit=[raw,...dirs.map(d=>d+raw),...dirs.map(d=>d+base)].find(x=>blobs.has(x));return hit?'map_Kd '+blobs.get(hit):line;}).join('\n');}return{objText,mtlText};}
async function loadZip(file){const d=await readZip(file),manager=new THREE.LoadingManager();const ol=new OBJLoader(manager);if(d.mtlText){const ml=new MTLLoader(manager);const mats=ml.parse(d.mtlText,'');mats.preload();ol.setMaterials(mats);}return ol.parse(d.objText);}
async function loadObj(file){return new OBJLoader().parse(await file.text());}
async function openFiles(files){const f=[...files].find(x=>/\.zip$/i.test(x.name))||[...files].find(x=>/\.obj$/i.test(x.name));if(!f)return;try{setStatus('Загрузка…');if(modelRoot){scene.remove(modelRoot);disposeObject(modelRoot);}const raw=/\.zip$/i.test(f.name)?await loadZip(f):await loadObj(f);modelRoot=splitModel(raw);scene.add(modelRoot);forceTextured();centerAndFit(modelRoot);rebuildParts();drop.classList.add('hidden');viewer.classList.remove('hidden');partsPanel.classList.remove('hidden');setStatus(`Готово: ${f.name}`);}catch(e){console.error(e);setStatus('Ошибка: '+e.message);alert('Ошибка загрузки: '+e.message);}}
openBtn.onclick=()=>fileInput.click();fileInput.onchange=()=>openFiles(fileInput.files);drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',e=>{e.preventDefault();openFiles(e.dataTransfer.files)});
document.getElementById('textureBtn').onclick=()=>setWire(false);document.getElementById('wireBtn').onclick=()=>setWire(true);document.getElementById('fitBtn').onclick=()=>modelRoot&&centerAndFit(modelRoot);document.getElementById('resetBtn').onclick=()=>{setWire(false);if(modelRoot)centerAndFit(modelRoot)};
function resize(){const w=canvas.clientWidth||innerWidth,h=canvas.clientHeight||innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()}addEventListener('resize',resize);resize();
(function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera)})();
