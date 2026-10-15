"""UI flow test in a synthetic browser context. No camera hardware/network required.
Optional dependency: pip install playwright; requires local chromium binary.
"""
from pathlib import Path
import json, base64, os, tempfile
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.getenv('SHOT_DIR', tempfile.gettempdir()))
html=(ROOT/'public/index.html').read_text(encoding='utf-8')
html=html.replace('<link rel="stylesheet" href="/assets/style.css" />','')
html=html.replace('<script src="/assets/app.js" defer></script>','')
css=(ROOT/'public/assets/style.css').read_text(encoding='utf-8')
js=(ROOT/'public/assets/app.js').read_text(encoding='utf-8').replace('const SHOT_COUNTDOWN = 5;', 'const SHOT_COUNTDOWN = 0;')
config=json.loads((ROOT/'public/assets/templates/config.json').read_text(encoding='utf-8'))
for t in config:
   jpg=(ROOT/'public'/t['preview'].lstrip('/')).read_bytes()
   t['preview']='data:image/jpeg;base64,'+base64.b64encode(jpg).decode('ascii')
   img=(ROOT/'public'/t['asset'].lstrip('/')).read_bytes() if t['id']=='rusa' else b''
   t['asset']='data:image/png;base64,'+base64.b64encode(img).decode('ascii') if img else ''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH') or None,headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream'])
 page=browser.new_page(viewport={'width':1365,'height':920},device_scale_factor=1)
 errors=[]
 page.on('pageerror',lambda err:errors.append(str(err)))
 page.set_content(html)
 page.add_style_tag(content=css)
 page.evaluate('''(config) => {
   const actualFetch=window.fetch.bind(window);
   window.fetch=async (path,options={})=>{
      if(path==='/api/templates') return new Response(JSON.stringify(config),{status:200,headers:{'content-type':'application/json'}});
      if(path==='/api/results') {
         const form=options.body;
         const blob=form.get('image');
         if(!blob || blob.size>20*1024*1024) return new Response(JSON.stringify({detail:'Invalid JPG'}),{status:413});
         const image=URL.createObjectURL(blob);
         window.submittedBlobSize=blob.size;
         return new Response(JSON.stringify({id:'mock',imageUrl:image,qrUrl:config[0].preview,resultUrl:'https://test.example/r/mock',waUrl:'https://wa.me/6281234567890?text=test',sizeBytes:blob.size}),{status:200,headers:{'content-type':'application/json'}});
      }
      return actualFetch(path,options);
   };
   const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=960;
   const ctx=canvas.getContext('2d');const gr=ctx.createLinearGradient(0,0,1280,960);gr.addColorStop(0,'#12b5f4');gr.addColorStop(1,'#f9e7b7');ctx.fillStyle=gr;ctx.fillRect(0,0,1280,960);
   ctx.fillStyle='#30335a';ctx.fillRect(150,150,350,400);ctx.font='90px sans-serif';ctx.fillText('LABKOM',180,680);
   window.fakeStream=canvas.captureStream(15);
   Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>window.fakeStream}});
}''',config)
 page.add_script_tag(content=js)
 page.wait_for_selector('.template-card',state='attached')
 page.screenshot(path=OUT/'photobooth-registrasi.png',full_page=True)
 page.fill('#field-name','Peserta Test')
 page.fill('#field-program','Teknik Informatika')
 page.fill('#field-phone','081234567890')
 page.check('#field-consent')
 page.click('#registration-form button[type="submit"]')
 assert page.locator('#pane-template').is_visible()
 page.screenshot(path=OUT/'photobooth-pilih-template.png',full_page=True)
 page.locator('.template-card[data-template="rusa"]').click()
 page.click('#template-next')
 page.wait_for_function('document.querySelector("#camera-video").readyState >= 2',timeout=20000)
 print('camera video state:',page.locator('#camera-video').evaluate('(el)=>el.readyState'))
 for i in range(3):
     page.click('#capture-button')
     if i < 2:page.wait_for_function(f'document.querySelectorAll("#shot-slots img").length >= {i+1}',timeout=12000)
     else:page.wait_for_function('!document.querySelector("#pane-review").hidden',timeout=12000)
 print('review visible',page.locator('#pane-review').is_visible())
 page.screenshot(path=OUT/'photobooth-review.png',full_page=True)
 # retake second photo:
 page.locator('.retake').nth(1).click()
 page.wait_for_function('!document.querySelector("#pane-camera").hidden')
 page.click('#capture-button')
 page.wait_for_function('!document.querySelector("#pane-review").hidden',timeout=12000)
 page.click('#confirm-button')
 page.wait_for_function('!document.querySelector("#pane-result").hidden',timeout=40000)
 print('result visible',page.locator('#pane-result').is_visible(),'blob bytes',page.evaluate('window.submittedBlobSize'))
 page.screenshot(path=OUT/'photobooth-selesai.png',full_page=True)
 print('JS page errors',errors)
 assert not errors
 browser.close()
