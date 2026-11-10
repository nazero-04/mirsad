import './inference.js';

const $ = (id) => document.getElementById(id);
const on = (id, event, fn) => $(id)?.addEventListener(event, fn);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent = (value) => `${(Number(value) * 100).toFixed(2)}%`;
const dateText = (value) => new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Riyadh'}).format(new Date(value));
const STORE = {reports:'mirsad_reports_v1', history:'mirsad_history_v1'};
function stored(key) { try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
const state = {data:null,image:null,filename:'',result:null,busy:false,source:'upload',sample:null,location:null,map:null,marker:null,reports:stored(STORE.reports),history:stored(STORE.history),stream:null,latestReport:null,activePanel:'scan'};
let toastTimer;
function toast(message) { const node=$('toast'); if(!node) return; node.textContent=message; node.hidden=false; node.classList.add('is-visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>{node.classList.remove('is-visible');node.hidden=true;},4800); }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { toast('تعذر الحفظ في هذا المتصفح. يمكنك تنزيل التقرير للاحتفاظ به.'); return false; } }
function css(url) { const l=document.createElement('link');l.rel='stylesheet';l.href=url;document.head.appendChild(l); }
function script(url) { return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=resolve;s.onerror=()=>reject(new Error('تعذر تحميل مكوّن الواجهة'));document.head.appendChild(s);}); }
function download(blob, filename) { const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500); }
function jsonDownload(object, filename) { download(new Blob([JSON.stringify(object,null,2)],{type:'application/json;charset=utf-8'}),filename); }
function csvDownload(rows, filename) { if(!rows.length) return toast('لا توجد بلاغات لتنزيلها بعد.');const keys=Object.keys(rows[0]);const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const text='\ufeff'+[keys.map(quote).join(','),...rows.map(r=>keys.map(k=>quote(r[k])).join(','))].join('\r\n');download(new Blob([text],{type:'text/csv;charset=utf-8'}),filename); }

css('./interactions.css');

const panelLabels={scan:['تحليل صورة جديدة','من صورة واحدة، تبدأ خطوة لحماية البحر.'],dashboard:['لوحة البيانات','نتائج واضحة، وقرارات قابلة للمراجعة.'],reports:['سجل البلاغات','بلاغاتك المحفوظة على هذا المتصفح.'],about:['عن مرصاد','من الرصد البصري إلى المعاينة الميدانية.']};
function showPanel(name) {
  if(!panelLabels[name]) return;
  state.activePanel=name;
  document.querySelectorAll('[data-panel]').forEach(b=>{const active=b.dataset.panel===name;b.classList.toggle('is-active',active);b.setAttribute('aria-current',active?'page':'false');});
  Object.keys(panelLabels).forEach(key=>{if($('panel-'+key)) $('panel-'+key).hidden=key!==name;});
  if($('pageTitle')) $('pageTitle').textContent=panelLabels[name][0];
  if($('pageSubtitle')) $('pageSubtitle').textContent=panelLabels[name][1];
  if(name==='dashboard') {renderReports();requestAnimationFrame(renderCharts);}
  if(name==='reports') renderReports();
  if(name==='scan') setTimeout(()=>state.map?.invalidateSize(),50);
  window.scrollTo({top:0,behavior:'smooth'});
}
document.querySelectorAll('[data-panel]').forEach(b=>b.addEventListener('click',()=>showPanel(b.dataset.panel)));
document.querySelectorAll('[data-dashboard-tab]').forEach(b=>b.addEventListener('click',()=>{
  const key=b.dataset.dashboardTab;
  document.querySelectorAll('[data-dashboard-tab]').forEach(x=>{const active=x===b;x.classList.toggle('is-active',active);x.setAttribute('aria-selected',String(active));});
  ['reports','model'].forEach(k=>{if($('dashboard-'+k)) $('dashboard-'+k).hidden=k!==key;});
  requestAnimationFrame(renderCharts);
}));

function progress(info) {
  const labels={download:'تحميل الموديل للمرة الأولى',loading:'تجهيز الموديل',init:'تجهيز الموديل',preprocess:'تجهيز الصورة',inference:'تحليل الصورة',postprocess:'تحديد مواقع المخلفات',ready:'الموديل جاهز'};
  const message=labels[info.stage] || (info.progress<1?'جارٍ تجهيز التحليل':'الموديل جاهز');
  if($('inferenceStatus')) $('inferenceStatus').textContent=message+(Number.isFinite(info.progress)&&info.progress<1?` · ${Math.round(info.progress*100)}%`:'');
  if($('modelStatus')) $('modelStatus').textContent=state.busy?'جارٍ التحليل':'جاهز';
}
function resetResult() {
  state.result=null;state.latestReport=null;
  if($('resultCard')) $('resultCard').hidden=true;
  if($('resultSummary')) $('resultSummary').textContent='ارفعي صورة ثم ابدئي التحليل.';
  if($('reviewCheck')) $('reviewCheck').checked=false;
  if($('exportReportBtn')) $('exportReportBtn').disabled=true;
  updateReportButton();
}
function drawImage() {
  const canvas=$('previewCanvas'); if(!canvas || !state.image) return;
  const w=state.image.naturalWidth || state.image.width, h=state.image.naturalHeight || state.image.height;
  const scale=Math.min(1,1280/w);canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);
  const ctx=canvas.getContext('2d');ctx.direction='ltr';ctx.textAlign='left';ctx.drawImage(state.image,0,0,canvas.width,canvas.height);
  for(const [index,box] of (state.result?.boxes || []).entries()) {
    const x=box.x1*scale,y=box.y1*scale,bw=(box.x2-box.x1)*scale,bh=(box.y2-box.y1)*scale;
    ctx.strokeStyle='#ff5a61';ctx.lineWidth=Math.max(2,canvas.width/450);ctx.strokeRect(x,y,bw,bh);
    const text=`${index+1} | ${(box.confidence*100).toFixed(0)}%`;ctx.font='600 14px Arial';
    const tw=ctx.measureText(text).width+12, tx=Math.max(0,Math.min(x,canvas.width-tw)),ty=Math.max(0,y-24);
    ctx.fillStyle='#c32940';ctx.fillRect(tx,ty,tw,23);ctx.fillStyle='#fff';ctx.fillText(text,tx+6,ty+16);
  }
  canvas.hidden=false;
  if($('previewPlaceholder')) $('previewPlaceholder').hidden=true;
  if($('previewMeta')) $('previewMeta').textContent=`${state.filename} · ${w} × ${h}`;
}
async function loadImage(url, filename, source='upload', sample=null) {
  if(state.busy) return toast('انتظري اكتمال التحليل الحالي.');
  const image=new Image();
  image.src=url;
  await image.decode();
  if(image.naturalWidth*image.naturalHeight>30000000) throw new Error('الصورة كبيرة جدًا. اختاري صورة أقل من 30 ميجابكسل.');
  state.image=image;state.filename=filename;state.source=source;state.sample=sample;resetResult();drawImage();
  if($('analyzeBtn')) $('analyzeBtn').disabled=false;
  if($('clearImageBtn')) $('clearImageBtn').hidden=false;
  if($('inferenceStatus')) $('inferenceStatus').textContent='الصورة جاهزة للتحليل';
}
async function acceptFile(file) {
  if(!file) return;
  if(!/^image\/(jpeg|png|webp|avif|bmp)$/.test(file.type)) return toast('اختاري صورة JPG أو PNG أو WebP.');
  if(file.size>20*1024*1024) return toast('الحد الأقصى لحجم الصورة هو 20 ميجابايت.');
  const url=URL.createObjectURL(file);
  try {await loadImage(url,file.name,'upload');} catch(error) {toast(error.message || 'تعذر فتح الصورة.');} finally {URL.revokeObjectURL(url);}
}
on('imageInput','change',e=>acceptFile(e.target.files[0]));
on('cameraInput','change',e=>acceptFile(e.target.files[0]));
on('clearImageBtn','click',()=>{
  if(state.busy) return;
  state.image=null;state.filename='';state.sample=null;resetResult();
  if($('previewCanvas')) $('previewCanvas').hidden=true;
  if($('previewPlaceholder')) $('previewPlaceholder').hidden=false;
  if($('previewMeta')) $('previewMeta').textContent='';
  if($('analyzeBtn')) $('analyzeBtn').disabled=true;
  if($('imageInput')) $('imageInput').value='';
  if($('clearImageBtn')) $('clearImageBtn').hidden=true;
  if($('inferenceStatus')) $('inferenceStatus').textContent='اختاري صورة للبدء';
});
const dropZone=$('imageInput')?.closest('.upload-card') || $('imageInput')?.parentElement;
if(dropZone) {
  ['dragover','dragenter'].forEach(e=>dropZone.addEventListener(e,x=>{x.preventDefault();dropZone.classList.add('is-dragging');}));
  ['dragleave','drop'].forEach(e=>dropZone.addEventListener(e,x=>{x.preventDefault();dropZone.classList.remove('is-dragging');}));
  dropZone.addEventListener('drop',e=>acceptFile(e.dataTransfer.files[0]));
}

on('analyzeBtn','click',async()=>{
  if(!state.image || state.busy) return;
  state.busy=true;$('analyzeBtn').disabled=true;resetResult();
  const oldText=$('analyzeBtn').textContent;$('analyzeBtn').textContent='جارٍ تحليل الصورة…';
  try {
    state.result=await window.MirsadInference.analyze(state.image,progress);
    drawImage();
    const count=state.result.boxes.length;
    const confidence=count?Math.max(...state.result.boxes.map(x=>x.confidence)):null;
    if($('resultCard')) { $('resultCard').hidden=false;$('resultCard').dataset.state=count?'detected':'clear'; }
    if($('resultSummary')) $('resultSummary').textContent=count?'رُصدت مخلفات مرئية محتملة':'لم يرصد الموديل مخلفات مرئية';
    if($('resultDetails')) $('resultDetails').innerHTML=`<div class="result-number"><b>${count}</b><span>أجسام مكتشفة</span></div><div class="result-number"><b>${confidence===null?'—':(confidence*100).toFixed(1)+'%'}</b><span>أعلى ثقة كشف</span></div><div class="result-number"><b>${(state.result.durationMs/1000).toFixed(1)} ث</b><span>زمن التحليل</span></div><p class="result-context">${count?'راجعي المربعات وحددي موقع البلاغ قبل تجهيز مهمة الفحص.':'هذه النتيجة تخص ما يظهر في الصورة، ولا تقيس جودة المياه.'}</p>`;
    if($('inferenceStatus')) $('inferenceStatus').textContent='اكتمل التحليل بالموديل المدرّب';
    if($('modelStatus')) $('modelStatus').textContent='الموديل جاهز';
    state.history.unshift({at:new Date().toISOString(),count,source:state.source});state.history=state.history.slice(0,150);save(STORE.history,state.history);
    renderReports();
  } catch(error) {
    console.error(error);
    if($('inferenceStatus')) $('inferenceStatus').textContent='تعذر إكمال التحليل. أعيدي المحاولة.';
    toast('تعذر تشغيل التحليل: '+(error.message || 'خطأ غير متوقع'));
  } finally {state.busy=false;$('analyzeBtn').disabled=!state.image;$('analyzeBtn').textContent=oldText;updateReportButton();}
});

async function openCamera() {
  if(state.busy) return;
  if(!navigator.mediaDevices?.getUserMedia) return $('cameraInput')?.click();
  try {
    state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    $('liveCamera').srcObject=state.stream;$('cameraDialog').showModal();await $('liveCamera').play();
  } catch {toast('تعذر فتح الكاميرا. اسمحي بالوصول إليها أو اختاري صورة من الملفات.');}
}
function stopCamera() { state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;if($('liveCamera')) $('liveCamera').srcObject=null; }
on('cameraLaunchBtn','click',openCamera);
on('cancelCameraBtn','click',()=>{$('cameraDialog').close();stopCamera();});
on('cameraDialog','close',stopCamera);
on('captureBtn','click',async()=>{
  const video=$('liveCamera');if(!video.videoWidth) return;
  const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
  const url=canvas.toDataURL('image/jpeg',.95);$('cameraDialog').close();stopCamera();
  try {await loadImage(url,'camera-photo.jpg','camera');} catch(e) {toast(e.message);}
});

function readCoordinates() {
  const a=$('latitude')?.value.trim(),b=$('longitude')?.value.trim();
  if(!a || !b) return null;
  const lat=Number(a),lon=Number(b);
  return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;
}
function setLocation(lat,lon,source='map') {
  $('latitude').value=lat.toFixed(6);$('longitude').value=lon.toFixed(6);state.location={lat,lon,source};
  if(state.map && window.L) {
    if(state.marker) state.marker.setLatLng([lat,lon]);
    else state.marker=L.marker([lat,lon],{icon:L.divIcon({className:'mirsad-map-pin',html:'<span></span>',iconSize:[26,26],iconAnchor:[13,13]})}).addTo(state.map);
  }
  if($('reportLocationNotice')) {$('reportLocationNotice').hidden=false;$('reportLocationNotice').textContent='تم تحديد موقع البلاغ. راجعي موضع النقطة على الخريطة.';}
  updateReportButton();
}
['latitude','longitude'].forEach(id=>on(id,'change',()=>{
  const point=readCoordinates();
  if(point) {setLocation(point.lat,point.lon,'coordinates');state.map?.setView([point.lat,point.lon],14);}
  else {state.location=null;updateReportButton();}
}));
['latitude','longitude'].forEach(id=>on(id,'input',updateReportButton));
on('locateBtn','click',()=>{
  if(!navigator.geolocation) return toast('تحديد الموقع غير متاح. اختاري نقطة على الخريطة.');
  $('locateBtn').disabled=true;
  navigator.geolocation.getCurrentPosition(pos=>{
    const {latitude:lat,longitude:lon}=pos.coords;setLocation(lat,lon,'device');state.map?.setView([lat,lon],15);$('locateBtn').disabled=false;
    toast('ظهر موقع جهازك. انقلي النقطة إذا كان موقع البلاغ مختلفًا.');
  },()=>{toast('تعذر تحديد موقع الجهاز. اختاري نقطة على الخريطة أو أدخلي الإحداثيات.');$('locateBtn').disabled=false;},{timeout:12000,maximumAge:30000});
});
async function initMap() {
  if(!$('map')) return;
  css('./lib/leaflet.css');await script('./lib/leaflet.js');$('map').replaceChildren();
  state.map=L.map('map',{scrollWheelZoom:false}).setView([21.61,39.10],12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'}).addTo(state.map);
  state.map.on('click',e=>setLocation(e.latlng.lat,e.latlng.lng,'map'));
  setTimeout(()=>state.map.invalidateSize(),200);
}
function updateReportButton() {
  const can=!!state.result?.boxes.length && !!readCoordinates() && !!$('reviewCheck')?.checked && !state.busy;
  if($('reportBtn')) $('reportBtn').disabled=!can;
}
on('reviewCheck','change',updateReportButton);
function thumbnail() { const c=document.createElement('canvas');const image=state.image;const w=image.naturalWidth||image.width,h=image.naturalHeight||image.height;c.width=240;c.height=Math.round(h/w*240);c.getContext('2d').drawImage(image,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.65); }
on('reportBtn','click',()=>{
  const location=readCoordinates();if(!location || !state.result?.boxes.length || !$('reviewCheck').checked) return;
  const report={id:'MR-'+Date.now().toString(36).toUpperCase(),created_at:new Date().toISOString(),location:{latitude:location.lat,longitude:location.lon,description:$('placeName')?.value.trim()||'موقع محدد على الخريطة',source:state.location?.source||'coordinates'},visible_litter_detected:true,detection_count:state.result.boxes.length,max_detection_confidence:Math.max(...state.result.boxes.map(b=>b.confidence)),status:'pending_field_review',human_image_reviewed:true,drone_task:{mode:'simulation',latitude:location.lat,longitude:location.lon,status:'prepared_not_dispatched'},thumbnail:thumbnail(),source:state.source,filename:state.filename};
  state.reports.unshift(report);state.reports=state.reports.slice(0,40);save(STORE.reports,state.reports);state.latestReport=report;
  if($('exportReportBtn')) $('exportReportBtn').disabled=false;
  $('reviewCheck').checked=false;updateReportButton();renderReports();toast('حُفظ البلاغ وجُهزت مهمة فحص تجريبية. لم تُرسل إلى درون.');
});
function exportReport(report) {const {thumbnail,...clean}=report;jsonDownload(clean,`Mirsad_${report.id}.json`);}
on('exportReportBtn','click',()=>{if(state.latestReport) exportReport(state.latestReport);});
on('csvExportBtn','click',()=>csvDownload(state.reports.map(r=>({report_id:r.id,created_at:r.created_at,place:r.location.description,latitude:r.location.latitude,longitude:r.location.longitude,detected_objects:r.detection_count,maximum_detection_confidence:r.max_detection_confidence,status:r.status,drone_mode:r.drone_task.mode})),'Mirsad_Reports.csv'));

function renderReports() {
  if($('liveReportsCount')) $('liveReportsCount').textContent=state.reports.length;
  if($('livePollutionCount')) $('livePollutionCount').textContent=state.history.filter(x=>x.count>0).length;
  if($('liveReviewCount')) $('liveReviewCount').textContent=state.reports.length;
  if($('latestReportTime')) $('latestReportTime').textContent=state.reports.length?dateText(state.reports[0].created_at):'لا توجد بلاغات بعد';
  if($('reportEmpty')) $('reportEmpty').hidden=state.reports.length>0;
  if($('reportList')) {
    $('reportList').innerHTML=state.reports.map((r,i)=>`<article class="report-row"><img src="${esc(r.thumbnail)}" alt="صورة البلاغ" loading="lazy"><div class="report-row-main"><div class="report-row-title"><h3>${esc(r.location.description)}</h3><span class="report-state">بانتظار المعاينة</span></div><p>${esc(r.id)} · ${esc(dateText(r.created_at))}</p><p dir="ltr" class="report-coordinates">${Number(r.location.latitude).toFixed(6)}, ${Number(r.location.longitude).toFixed(6)}</p><p>${r.detection_count} أجسام مرصودة · مهمة درون تجريبية</p></div><button class="report-download" data-report-download="${i}" type="button">تنزيل التقرير</button></article>`).join('');
    $('reportList').querySelectorAll('[data-report-download]').forEach(b=>b.addEventListener('click',()=>exportReport(state.reports[Number(b.dataset.reportDownload)])));
  }
  if($('csvExportBtn')) $('csvExportBtn').disabled=!state.reports.length;
  if(state.activePanel==='dashboard') requestAnimationFrame(renderCharts);
}

function lineChart(canvas, series, labels, options={}) {
  if(!canvas || canvas.closest('[hidden]')) return;
  const width=canvas.clientWidth||640,height=canvas.clientHeight||260,dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const pad={l:42,r:18,t:28,b:38};const plotW=width-pad.l-pad.r,plotH=height-pad.t-pad.b;
  const values=series.flatMap(s=>s.values);const max=options.max??Math.max(1,...values)*1.12;
  ctx.font='11px Arial';ctx.textAlign='right';ctx.textBaseline='middle';
  for(let j=0;j<=4;j++){const y=pad.t+j*plotH/4;ctx.strokeStyle='#e7eef0';ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(width-pad.r,y);ctx.stroke();ctx.fillStyle='#809398';ctx.fillText((max*(1-j/4)).toFixed(options.integer?0:1),pad.l-9,y);}
  const pos=i=>pad.l+(labels.length>1?i/(labels.length-1):.5)*plotW;
  ctx.textAlign='center';ctx.fillStyle='#718b91';
  labels.forEach((lab,i)=>{if(labels.length<=8||i===0||i===labels.length-1||i%5===4)ctx.fillText(String(lab),pos(i),height-16);});
  series.forEach(s=>{ctx.strokeStyle=s.color;ctx.lineWidth=2.6;ctx.lineJoin='round';ctx.beginPath();s.values.forEach((v,i)=>{const x=pos(i),y=pad.t+plotH-(v/max)*plotH;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();if(s.values.length===1){ctx.fillStyle=s.color;ctx.beginPath();ctx.arc(pos(0),pad.t+plotH-(s.values[0]/max)*plotH,4,0,Math.PI*2);ctx.fill();}});
}
function renderCharts() {
  if(state.data?.training) {
    const t=state.data.training;
    lineChart($('trainingChart'),[{color:'#008a91',values:t.map(x=>x['train/box_loss'])},{color:'#dbad6b',values:t.map(x=>x['val/box_loss'])}],t.map(x=>x.epoch));
  }
  const keys=[];const counts=[];
  for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const k=d.toLocaleDateString('en-CA',{timeZone:'Asia/Riyadh'});keys.push(d.toLocaleDateString('ar-SA-u-ca-gregory-nu-latn',{day:'numeric',month:'short',timeZone:'Asia/Riyadh'}));counts.push(state.reports.filter(r=>new Date(r.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Riyadh'})===k).length);}
  lineChart($('liveReportChart'),[{color:'#008a91',values:counts}],keys,{integer:true,max:Math.max(4,...counts)});
}
window.addEventListener('resize',()=>{requestAnimationFrame(renderCharts);state.map?.invalidateSize();});

async function showShare() {
  if(!$('shareDialog')) return;
  const url=new URL('./',document.baseURI).href;$('siteLink').value=url;$('shareDialog').showModal();
  try {if(!window.qrcode) await script('./lib/qrcode.js');const qr=qrcode(0,'M');qr.addData(url);qr.make();$('qrCode').innerHTML=qr.createSvgTag({cellSize:5,margin:3,scalable:true});$('qrCode').querySelector('svg')?.setAttribute('aria-label','رمز QR لرابط مرصاد');} catch { $('qrCode').textContent='يمكنك نسخ الرابط أدناه.'; }
}
on('qrBtn','click',showShare);
on('closeShareBtn','click',()=>$('shareDialog').close());
on('copyLinkBtn','click',async()=>{try{await navigator.clipboard.writeText($('siteLink').value);toast('نُسخ رابط الموقع.');}catch{$('siteLink').select();document.execCommand('copy');toast('نُسخ رابط الموقع.');}});

async function init() {
  try {
    const response=await fetch('./assets/data.json');if(!response.ok) throw new Error('تعذر تحميل بيانات المشروع');state.data=await response.json();
    if($('sampleGrid')) {
      $('sampleGrid').innerHTML=state.data.samples.map((s,i)=>`<button class="sample-card" data-sample="${i}" type="button"><img src="${esc(s.url)}" alt="${esc(s.label)} من مجموعة الاختبار" loading="lazy"><span>${esc(s.label)}</span></button>`).join('');
      $('sampleGrid').querySelectorAll('[data-sample]').forEach(b=>b.addEventListener('click',async()=>{const s=state.data.samples[Number(b.dataset.sample)];try{await loadImage(s.url,s.file,'dataset_example',s);$('analyzeBtn')?.focus();}catch(e){toast(e.message);}}));
    }
    const d=state.data.decision,det=state.data.detection;
    const metrics={imageAccuracy:percent(d.metrics.accuracy),imagePrecision:percent(d.metrics.precision),imageRecall:percent(d.metrics.recall),imageF1:percent(d.metrics.f1),detectionMap50:percent(det.metrics.map50),detectionMap5095:percent(det.metrics.map50_95),detectionPrecision:percent(det.metrics.precision),detectionRecall:percent(det.metrics.recall),testImageCount:d.number_of_images,falseAlarmCount:d.confusion_counts.fp,missedImageCount:d.confusion_counts.fn,truePositiveCount:d.confusion_counts.tp,trueNegativeCount:d.confusion_counts.tn};
    for(const [id,value] of Object.entries(metrics)) if($(id)) $(id).textContent=value;
    document.querySelectorAll('[data-metric]').forEach(n=>{if(metrics[n.dataset.metric]!==undefined)n.textContent=metrics[n.dataset.metric];});
    $('trainingChart')?.parentElement?.insertAdjacentHTML('afterend','<p class="chart-footnote"><span style="color:#008a91">━ التدريب</span> &nbsp; <span style="color:#99703a">━ التحقق</span> · خسارة تحديد المربعات (Box loss)</p>');
    renderReports();renderCharts();
  } catch(error) {toast(error.message);console.error(error);}
  try {await initMap();} catch(error) {if($('map')) $('map').innerHTML='<div class="map-fallback">تعذر تحميل الخريطة. يمكنك إدخال خط العرض والطول في الحقول أدناه.</div>';console.error(error);}
  if($('analyzeBtn')) $('analyzeBtn').disabled=!state.image || state.busy;
  if($('exportReportBtn')) $('exportReportBtn').disabled=true;
  updateReportButton();
}

init();
window.MirsadApp={state,showPanel};
