// Isolated browser fixture: only a loopback server, no real accounts or API calls.
const fs = require('node:fs'), http = require('node:http'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const frontend = process.env.LTHS_FRONTEND_DIR || 'C:/LTHS-FRONTEND';
const vm = require('node:vm');
for (const name of ['pages/admin/queue.html', 'pages/dept-head/queue.html', 'pages/approval.html', 'pages/admin/search.html', 'pages/dept-head/documents.html', 'pages/my-documents.html', 'pages/upload.html']) {
  for (const [, script] of fs.readFileSync(path.join(frontend, name), 'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script, { filename: name });
}
const app = fs.readFileSync(path.join(frontend, 'assets/js/app.js'), 'utf8');
const preview = app.slice(app.indexOf('async function previewFile('), app.indexOf('const documentLibraryRequests'));
const ui = app.slice(app.indexOf('// Document dossier UI.'));
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
${fs.readFileSync(path.join(frontend, 'assets/css/style.css'), 'utf8')}
${fs.readFileSync(path.join(frontend, 'assets/css/interface.css'), 'utf8')}
</style></head><body><button id="details" onclick="openQueueDocumentDetail(root)">Chi tiết</button><div id="modal-detail-content"></div><script>
const root = { id:'root', title:'Hồ sơ kiểm tra', originalFilename:'test.pdf', status:'stored', department:{id:'dept',name:'Khoa A'}, uploader:{id:'owner',fullName:'Người tải'}, visibility:'department' };
const Auth = { getUser:()=>({id:'owner',role:'user',departmentId:'dept'}), permissions:()=>[], isStaff:()=>false };
const Toast = { warning:()=>{} };
const esc = value => String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const documentMetadataHtml = doc => '<p>'+esc(doc.title)+'</p>';
const canAccessDocumentSecurity = ()=>true;
const isUploadedByCurrentUser = (doc,user)=>doc.uploader.id===user.id;
const documentFileNameForType = (doc,name)=>name;
const documentMimeType = ()=>'application/pdf';
const isArchiveDocumentFile = ()=>false, isArchiveMimeType = ()=>false;
const fetchDocumentView = async()=>({blob:async()=>new Blob(['pdf'],{type:'application/pdf'})});
const renderPreviewBlob = async()=>{ document.getElementById('pdf-preview-body').textContent='PDF fixture'; };
const loadDocumentDetail = async doc=>({...root,...doc});
window.uploaded = [];
const api = { get:async()=>({dossierRootId:'root',data:[root,...uploaded.map((_,i)=>({...root,id:'extra-'+i,title:'File bổ sung',status:'pending'}))],total:1+uploaded.length,page:1,limit:20}),
upload:async(url,data)=>{ uploaded.push({url,root:data.get('dossierRootId'),filename:data.get('file').name}); } };
${preview}
${ui}
</script></body></html>`;
const server = http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture);});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function connect(url) {
  return new Promise(resolve=>{
    const ws = new WebSocket(url), pending = new Map(); let id=0;
    ws.onmessage = event=>{ const response=JSON.parse(event.data); if(response.id) { const p=pending.get(response.id);pending.delete(response.id);response.error?p.reject(Error(response.error.message)):p.resolve(response.result); } };
    ws.onopen=()=>resolve({ws,call:(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});ws.send(JSON.stringify({id:next,method,params}));})});
  });
}
async function evaluate(cdp,expression) {
  const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function main() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'lths-dossier-test-'));
  const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let cdp;
  try {
    let port;
    for(let i=0;i<100;i++) { try {port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch {await delay(100);} }
    if(!port) throw Error('Browser did not start');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();
    cdp=await connect(tab.webSocketDebuggerUrl);
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp.call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    for(let i=0;i<50;i++) {if(await evaluate(cdp,"typeof openQueueDocumentDetail==='function'"))break;await delay(100);}
    assert.equal(await evaluate(cdp,"(async()=>{await openQueueDocumentDetail(root);return document.querySelector('#modal-queue-detail').classList.contains('open') && document.querySelector('[data-queue-detail]').textContent.includes('Hồ sơ kiểm tra')})()"),true);
    assert.equal(await evaluate(cdp,"(async()=>{await previewFile('root','test.pdf',{doc:root});return document.querySelector('#modal-pdf-preview .modal').getBoundingClientRect().width>1300})()"),true);
    await evaluate(cdp,"document.getElementById('pdf-close-btn').click();document.querySelector('#modal-queue-detail .modal-close').click()");
    assert.equal(await evaluate(cdp,"(async()=>{await mountDocumentDossier(root);return !!document.querySelector('[data-upload] input')})()"),true);
    const uploaded=await evaluate(cdp,`(async()=>{
      const input=document.querySelector('[data-upload] input'), files=new DataTransfer();
      files.items.add(new File(['a'],'lien-quan.pdf',{type:'application/pdf'}));
      files.items.add(new File(['b'],'bo-sung.pdf',{type:'application/pdf'}));input.files=files.files;
      await document.querySelector('[data-upload] form').onsubmit({preventDefault(){}});
      return {uploaded,rows:document.querySelectorAll('.dossier-row').length,status:document.querySelector('[data-result]').textContent};
    })()`);
    assert.equal(uploaded.uploaded.length,2);assert.equal(uploaded.rows,3);assert.ok(uploaded.uploaded.every(file=>file.root==='root'));
    assert.ok(uploaded.status.includes('2/2'));
    assert.equal(await evaluate(cdp,"(()=>{previewLocalUpload(new File(['pdf'],'kiem-tra.pdf',{type:'application/pdf'}));return !!document.querySelector('#modal-local-upload iframe')})()"),true);
    await evaluate(cdp,"document.querySelector('#modal-local-upload [data-close]').click()");
    assert.equal(await evaluate(cdp,"!document.getElementById('modal-local-upload')"),true);
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.equal(await evaluate(cdp,"(async()=>{await openQueueDocumentDetail(root);return document.documentElement.scrollWidth<=innerWidth})()"),true);
    console.log('Browser checks passed: details, wide preview, two related uploads, refreshed dossier, local PDF preview and mobile layout.');
  } finally {
    cdp?.ws.close();browser.kill();server.closeAllConnections();server.close();
    await delay(500);
    const resolved=path.resolve(profile), temp=path.resolve(os.tmpdir())+path.sep;
    if(resolved.startsWith(temp)&&path.basename(resolved).startsWith('lths-dossier-test-')) {
      try { fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:200}); }
      catch(error) { if (!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code)) throw error; }
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;server.closeAllConnections();server.close();});
