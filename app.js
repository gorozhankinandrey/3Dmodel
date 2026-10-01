import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";

const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("fileInput");
const openBtn = document.getElementById("openBtn");
const drop = document.getElementById("drop");
const viewer = document.getElementById("viewer");
const partsPanel = document.getElementById("partsPanel");
const partsList = document.getElementById("partsList");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0f2f4);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200000);
camera.position.set(2500, 1700, 2500);

const renderer = new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:"high-performance"});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minDistance = 1;
controls.maxDistance = 200000;
controls.target.set(0,0,0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8b929a, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.8);
key.position.set(2500,4000,2500);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 1.2);
fill.position.set(-2500,1500,-1800);
scene.add(fill);

const grid = null; // намеренно без сетки
let modelRoot = null;
let originalMaterials = new Map();
let selected = null;
let objectId = 0;
const hiddenObjects = new Set();

function setStatus(t){ statusEl.textContent = t; }

function disposeObject(root){
  root?.traverse(o=>{
    if(o.geometry) o.geometry.dispose();
    if(o.material){
      const ms = Array.isArray(o.material)?o.material:[o.material];
      ms.forEach(m=>m.dispose());
    }
  });
}

function prepareMaterials(root){
  originalMaterials.clear();
  root.traverse(o=>{
    if(!o.isMesh) return;
    const mats = Array.isArray(o.material)?o.material:[o.material];
    mats.forEach(m=>{
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.depthTest = true;
      m.side = THREE.FrontSide;
      if("roughness" in m) m.roughness = Math.max(0.35, m.roughness);
      if(m.map){ m.map.colorSpace = THREE.SRGBColorSpace; m.map.needsUpdate = true; }
      originalMaterials.set(m, {transparent:m.transparent, opacity:m.opacity, side:m.side});
    });
    o.userData.partId = ++objectId;
    o.userData.partName = (o.name && o.name !== "Object3D") ? o.name : `Деталь ${o.userData.partId}`;
  });
}

function forceTextured(){
  if(!modelRoot) return;
  modelRoot.traverse(o=>{
    if(!o.isMesh) return;
    const mats = Array.isArray(o.material)?o.material:[o.material];
    mats.forEach(m=>{
      const base = originalMaterials.get(m);
      if(base){ m.transparent=false; m.opacity=1; m.side=THREE.FrontSide; }
      if(m.map){ m.map.colorSpace=THREE.SRGBColorSpace; m.map.needsUpdate=true; }
      m.wireframe=false;
      m.depthWrite=true;
    });
  });
}

function wireframeMode(on){
  if(!modelRoot) return;
  modelRoot.traverse(o=>{
    if(!o.isMesh) return;
    const mats = Array.isArray(o.material)?o.material:[o.material];
    mats.forEach(m=>{
      m.wireframe = on;
      // Важный момент: FrontSide + depthTest/depthWrite не дают задним граням
      // просвечивать сквозь передние.
      m.side = THREE.FrontSide;
      m.transparent = on;
      m.opacity = on ? 0.9 : 1;
      m.depthWrite = true;
      m.depthTest = true;
    });
  });
}

function centerAndFit(root){
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  const box2 = new THREE.Box3().setFromObject(root);
  const s = box2.getSize(new THREE.Vector3());
  const maxDim = Math.max(s.x,s.y,s.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  let dist = maxDim/(2*Math.tan(fov/2));
  dist *= 1.25;
  camera.near = Math.max(0.01, maxDim/100000);
  camera.far = Math.max(1000, maxDim*100);
  camera.position.set(dist*0.95, dist*0.65, dist*0.95);
  controls.target.set(0,0,0);
  controls.minDistance=Math.max(0.1,maxDim/10000);
  controls.maxDistance=Math.max(1000,maxDim*20);
  controls.update();
}

async function readZip(file){
  setStatus("Читаю ZIP…");
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(x=>!x.dir);
  const names = entries.map(x=>x.name);
  const objName = names.find(n=>/\.obj$/i.test(n));
  if(!objName) throw new Error("В ZIP не найден OBJ");
  const mtlName = names.find(n=>/\.mtl$/i.test(n));
  const blobs = new Map();
  for(const e of entries){
    const ext = e.name.split(".").pop().toLowerCase();
    if(["jpg","jpeg","png","bmp","webp"].includes(ext)){
      const b = await e.async("blob");
      blobs.set(e.name.replaceAll("\\","/"), URL.createObjectURL(b));
    }
  }
  const objText = await zip.file(objName).async("string");
  let mtlText = mtlName ? await zip.file(mtlName).async("string") : null;
  if(mtlText){
    const mtlDir = mtlName.includes("/") ? mtlName.slice(0,mtlName.lastIndexOf("/")+1) : "";
    const objDir = objName.includes("/") ? objName.slice(0,objName.lastIndexOf("/")+1) : "";
    mtlText = mtlText.split(/\r?\n/).map(line=>{
      if(!/^map_Kd\s+/i.test(line)) return line;
      const raw = line.replace(/^map_Kd\s+/i,"").trim().replaceAll("\\","/");
      const candidates = [
        raw,
        mtlDir+raw,
        objDir+raw,
        raw.split("/").pop()
      ];
      const hit = candidates.find(c=>blobs.has(c));
      return hit ? "map_Kd " + blobs.get(hit) : line;
    }).join("\n");
  }
  return {objText, mtlText, blobs};
}

async function loadFromZip(file){
  const data = await readZip(file);
  const manager = new THREE.LoadingManager();
  const objLoader = new OBJLoader(manager);
  let materials = null;
  if(data.mtlText){
    const mtlLoader = new MTLLoader(manager);
    materials = mtlLoader.parse(data.mtlText, "");
    materials.preload();
    materials.materialsInfo && Object.values(materials.materialsInfo).forEach(info=>{
      if(info.map_kd && /^blob:/.test(info.map_kd)) info.map_kd = info.map_kd;
    });
    objLoader.setMaterials(materials);
  }
  const root = objLoader.parse(data.objText);
  return root;
}

async function loadPlainOBJ(file){
  const text = await file.text();
  const loader = new OBJLoader();
  return loader.parse(text);
}

function rebuildPartsPanel(){
  partsList.innerHTML="";
  if(!modelRoot) return;
  const meshes=[];
  modelRoot.traverse(o=>{ if(o.isMesh) meshes.push(o); });
  meshes.forEach((m,i)=>{
    const row=document.createElement("div");
    row.className="part";
    const name=document.createElement("div");
    name.className="part-name";
    name.textContent=m.userData.partName || `Деталь ${i+1}`;
    const focus=document.createElement("button");
    focus.textContent="Показать";
    focus.onclick=()=>{ m.visible=true; hiddenObjects.delete(m); };
    const hide=document.createElement("button");
    hide.textContent="Скрыть";
    hide.onclick=()=>{ m.visible=false; hiddenObjects.add(m); };
    row.append(name,focus,hide);
    partsList.appendChild(row);
  });
}

function selectMesh(mesh){
  if(selected?.material){
    const mats=Array.isArray(selected.material)?selected.material:[selected.material];
    mats.forEach(m=>{m.emissive?.setHex(0x000000);});
  }
  selected=mesh;
  if(!selected) return;
  const mats=Array.isArray(selected.material)?selected.material:[selected.material];
  mats.forEach(m=>{ if(m.emissive) m.emissive.setHex(0x244cff); });
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(ev){
  if(!modelRoot) return;
  const r=canvas.getBoundingClientRect();
  pointer.x=((ev.clientX-r.left)/r.width)*2-1;
  pointer.y=-((ev.clientY-r.top)/r.height)*2+1;
  raycaster.setFromCamera(pointer,camera);
  const hits=raycaster.intersectObject(modelRoot,true);
  if(!hits.length) return;
  let m=hits[0].object;
  if(m.isMesh) selectMesh(m);
}

canvas.addEventListener("pointerdown", e=>{
  // Не мешаем обычному вращению. Выбор происходит коротким tap/click.
  canvas._pickStart={x:e.clientX,y:e.clientY,t:performance.now()};
});
canvas.addEventListener("pointerup", e=>{
  const s=canvas._pickStart;
  if(!s) return;
  const moved=Math.hypot(e.clientX-s.x,e.clientY-s.y);
  if(moved<7 && performance.now()-s.t<500) pick(e);
  canvas._pickStart=null;
});

async function openFiles(files){
  if(!files?.length) return;
  try{
    const file=[...files].find(f=>/\.zip$/i.test(f.name)) || [...files].find(f=>/\.obj$/i.test(f.name));
    if(!file) throw new Error("Выберите OBJ или ZIP");
    if(modelRoot){ scene.remove(modelRoot); disposeObject(modelRoot); }
    setStatus("Загрузка…");
    modelRoot = /\.zip$/i.test(file.name) ? await loadFromZip(file) : await loadPlainOBJ(file);
    prepareMaterials(modelRoot);
    forceTextured();
    scene.add(modelRoot);
    centerAndFit(modelRoot);
    drop.classList.add("hidden");
    viewer.classList.remove("hidden");
    partsPanel.classList.remove("hidden");
    rebuildPartsPanel();
    setStatus(`Готово: ${file.name}`);
  }catch(err){
    console.error(err);
    setStatus("Ошибка: "+(err?.message || err));
    alert("Ошибка загрузки: "+(err?.message || err));
  }
}

document.getElementById("textureBtn").onclick=()=>{
  forceTextured();
  document.getElementById("textureBtn").classList.add("active");
  document.getElementById("wireBtn").classList.remove("active");
};
document.getElementById("wireBtn").onclick=()=>{
  wireframeMode(true);
  document.getElementById("wireBtn").classList.add("active");
  document.getElementById("textureBtn").classList.remove("active");
};
document.getElementById("fitBtn").onclick=()=>{ if(modelRoot) centerAndFit(modelRoot); };
document.getElementById("resetBtn").onclick=()=>{
  if(modelRoot){ forceTextured(); centerAndFit(modelRoot); }
  document.getElementById("textureBtn").classList.add("active");
  document.getElementById("wireBtn").classList.remove("active");
};
document.getElementById("showAllBtn").onclick=()=>{
  modelRoot?.traverse(o=>{if(o.isMesh)o.visible=true});
  hiddenObjects.clear();
};

openBtn.onclick=()=>fileInput.click();
fileInput.onchange=()=>openFiles(fileInput.files);
drop.addEventListener("dragover",e=>{e.preventDefault();drop.style.borderColor="#20252b"});
drop.addEventListener("dragleave",()=>drop.style.borderColor="#c9ced6");
drop.addEventListener("drop",e=>{e.preventDefault();drop.style.borderColor="#c9ced6";openFiles(e.dataTransfer.files)});

function resize(){
  const w=canvas.clientWidth||window.innerWidth, h=canvas.clientHeight||window.innerHeight;
  renderer.setSize(w,h,false);
  camera.aspect=w/h; camera.updateProjectionMatrix();
}
window.addEventListener("resize",resize);
resize();

function animate(){
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene,camera);
}
animate();
