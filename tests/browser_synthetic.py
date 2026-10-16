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
   img=(ROOT/'public'/t['asset'].lstrip('/')).read_bytes() if t['id']=='akasha' else b''
   t['asset']='data:image/png;base64,'+base64.b64encode(img).decode('ascii') if img else ''
stickers=[]
for f in sorted((ROOT/'public/assets/stickers').iterdir()):
   mime='image/svg+xml' if f.suffix=='.svg' else 'image/png'
   stickers.append(f'data:{mime};base64,'+base64.b64encode(f.read_bytes()).decode('ascii'))
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH') or None,headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream'])
 page=browser.new_page(viewport={'width':1365,'height':920},device_scale_factor=1)
 errors=[]
 page.on('pageerror',lambda err:errors.append(str(err)))
 page.set_content(html)
 page.add_style_tag(content=css)
 page.evaluate('''([config,stickers]) => {
   const actualFetch=window.fetch.bind(window);
   window.fetch=async (path,options={})=>{
      if(path==='/api/templates') return new Response(JSON.stringify(config),{status:200,headers:{'content-type':'application/json'}});
      if(path==='/api/stickers') return new Response(JSON.stringify(stickers),{status:200,headers:{'content-type':'application/json'}});
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
}''',[config,stickers])
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
 page.locator('.template-card[data-template="akasha"]').click()
 page.click('#template-next')
 page.wait_for_function('document.querySelector("#camera-video").readyState >= 2',timeout=20000)
 print('camera video state:',page.locator('#camera-video').evaluate('(el)=>el.readyState'))
 # live Photo Booth effect: pixel effects render into #live-effect over the video
 page.locator('#live-effects button', has_text='Thermal').click()
 page.wait_for_timeout(400)
 assert page.locator('#live-effect').is_visible()
 page.screenshot(path=OUT/'photobooth-kamera-efek.png',full_page=True)
 # one press shoots all four photos automatically
 page.click('#capture-button')
 page.wait_for_function('!document.querySelector("#pane-review").hidden',timeout=20000)
 assert page.evaluate('state.photos.length===4 && state.photos.every(Boolean)')
 assert page.evaluate('state.filters.every(f=>f==="thermal")')
 assert page.evaluate('[...document.querySelectorAll(".review-shot div span")].map(e=>e.textContent)')==['Jendela kiri atas','Jendela kanan atas','Jendela kiri bawah','Jendela kanan bawah']
 rusa=next(t for t in config if t['id']=='rusa')
 assert page.evaluate('(c)=>{const t=state.template;state.template=c;const n=[0,1,2].map(slotName);state.template=t;return n}',rusa)==['atas','tengah','bawah']
 print('review visible',page.locator('#pane-review').is_visible())
 page.screenshot(path=OUT/'photobooth-review.png',full_page=True)
 # per-photo filter: photo 2 gets Pop Art, the rest keep Thermal
 page.click('.review-tab[data-tab="filter"]')
 page.locator('#filter-target .target-chip').nth(2).click()
 page.locator('#filter-grid .filter-chip', has_text='Pop Art').click()
 assert page.evaluate('JSON.stringify(state.filters)')=='["thermal","popart","thermal","thermal"]'
 page.wait_for_timeout(500)
 page.screenshot(path=OUT/'photobooth-filter.png',full_page=True)
 # image sticker + emoji, rotated
 page.click('.review-tab[data-tab="sticker"]')
 page.locator('#sticker-grid .emoji-btn').first.click()
 page.click('#sticker-rotr')
 page.locator('#emoji-grid .emoji-btn').first.click()
 assert page.evaluate('state.stickers.length===2 && state.stickers[0].src && state.stickers[0].rot===15')
 page.screenshot(path=OUT/'photobooth-stiker.png',full_page=True)
 # retake second photo (camera reopens with that photo's effect):
 page.click('.review-tab[data-tab="shots"]')
 page.locator('.retake').nth(1).click()
 page.wait_for_function('!document.querySelector("#pane-camera").hidden')
 page.click('#capture-button')
 page.wait_for_function('!document.querySelector("#pane-review").hidden',timeout=12000)
 assert page.evaluate('state.filters[1]')=='popart'
 page.click('#confirm-button')
 page.wait_for_function('!document.querySelector("#pane-result").hidden',timeout=40000)
 print('result visible',page.locator('#pane-result').is_visible(),'blob bytes',page.evaluate('window.submittedBlobSize'))
 page.screenshot(path=OUT/'photobooth-selesai.png',full_page=True)
 print('JS page errors',errors)
 assert not errors
 browser.close()
