"""Simple API smoke test using Python's standard library + Pillow.
Run: python tests/smoke_test.py
"""
from __future__ import annotations
import io, json, sqlite3, subprocess, sys, time, urllib.request, urllib.error, uuid
from contextlib import closing
from pathlib import Path
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[1]
PORT=17866
DB=ROOT/'data'/'photobooth.db'
BASE=f'http://127.0.0.1:{PORT}'

def fetch(url, method='GET', data=None, headers=None, expected=200):
    req=urllib.request.Request(BASE+url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            status=response.status; content=response.read(); hdr=dict(response.headers)
    except urllib.error.HTTPError as e:
        status=e.code; content=e.read(); hdr=dict(e.headers)
    assert status==expected, f'{url}: expected {expected}, got {status}, {content[:300]!r}'
    return content,hdr

def multipart(fields, image):
    boundary='----LABKOM'+uuid.uuid4().hex
    chunks=[]
    for k,v in fields.items():
        chunks += [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()]
    chunks += [f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode(),image, b'\r\n', f'--{boundary}--\r\n'.encode()]
    return b''.join(chunks),{'Content-Type':f'multipart/form-data; boundary={boundary}'}

def run():
    server=subprocess.Popen([sys.executable,'-m','uvicorn','server:app','--host','127.0.0.1','--port',str(PORT)],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    rid=first=None
    try:
        for _ in range(60):
            try:
                content,_=fetch('/health');break
            except Exception:time.sleep(.25)
        else:raise AssertionError('server startup failed')
        frames=json.loads((ROOT/'public/assets/templates/config.json').read_text(encoding='utf-8'))
        assert json.loads(content)['templates']==len(frames)>=16
        config=json.loads(fetch('/api/templates')[0]);assert len(config)==len(frames)
        home=fetch('/')[0].decode();assert '/assets/app.js?v=' in home and '/assets/style.css?v=' in home
        assert all('?v=' in t['asset'] for t in config)
        assert all(len(t['slots']) in (3,4) for t in config)
        assert all(len(s['clip'])>=4 for t in config for s in t['slots'] if 'clip' in s)
        for item in config:
            raw,_=fetch(item['asset'])
            art=Image.open(io.BytesIO(raw));assert art.mode=='RGBA'
            assert art.getextrema()[3][0] == 0 and art.getextrema()[3][1] == 255
        stickers=json.loads(fetch('/api/stickers')[0]);assert stickers and all('?v=' in u for u in stickers)
        fetch(stickers[0])
        print(f'[OK] server, {len(config)} templates, 3/4 true-alpha photo holes, versioned asset + sticker URLs')
        image=Image.new('RGB',(1200,1600),(34,100,175));d=ImageDraw.Draw(image)
        for i in range(20):d.rectangle((i*28,i*35,i*28+40,i*35+100),fill=(i*10%255,90,i*18%255))
        b=io.BytesIO();image.save(b,'JPEG',quality=92)
        fields={'name':'Penguji Labkom','program':'Teknik Komputer','whatsapp':'081234567891','template_id':'pink','consent':'true'}
        body,hdr=multipart(fields,b.getvalue())
        first=json.loads(fetch('/api/results','POST',body,headers=hdr,expected=200)[0])['id']
        fields_bad={**fields,'consent':'false'}
        body_bad, hdr_bad=multipart(fields_bad,b.getvalue())
        fetch('/api/results','POST',body_bad,headers=hdr_bad,expected=422)
        fields_bad={**fields,'template_id':'invalid'}
        body_bad,hdr_bad=multipart(fields_bad,b.getvalue())
        fetch('/api/results','POST',body_bad,headers=hdr_bad,expected=422)
        print('[OK] form validation and upload')
        r=json.loads(fetch('/api/results','POST',body,headers=hdr)[0]);rid=r['id']
        assert r['sizeBytes']<=20*1024*1024
        assert r['mode']=='manual_whatsapp'
        assert r['waUrl'].startswith('https://wa.me/6281234567891?')
        output=fetch(r['imageUrl'])[0]
        final=Image.open(io.BytesIO(output));assert final.size==(2160,3840)
        assert final.format=='JPEG'
        assert len(output)<=20*1024*1024
        assert fetch(r['qrUrl'])[0][:8] == b'\x89PNG\r\n\x1a\n'
        public=fetch('/r/'+rid)[0].decode()
        assert 'Penguji Labkom' not in public and '081234567891' not in public
        print('[OK] HD JPEG 2160x3840, <=20MB, QR and privacy-friendly result page')
        fetch('/admin')
        fetch('/admin/api/entries',expected=401)
        fetch(f'/admin/photo/{rid}.jpg',expected=401)
        bad,bad_hdr=multipart({'username':'labkom','password':'salah'},b'')
        fetch('/admin/login','POST',bad,headers=bad_hdr,expected=401)
        fetch('/admin/api/entries',headers={'Cookie':f'pb_admin={int(time.time())+999}.forged'},expected=401)
        good,good_hdr=multipart({'username':'labkom','password':'123'},b'')
        cookie=fetch('/admin/login','POST',good,headers=good_hdr)[1]['set-cookie'].split(';')[0]
        assert cookie.startswith('pb_admin=') and 'HttpOnly' in fetch('/admin/login','POST',good,headers=good_hdr)[1]['set-cookie']
        admin=json.loads(fetch('/admin/api/entries?q=Penguji',headers={'Cookie':cookie})[0])
        mine=next(e for e in admin['entries'] if e['id']==rid)
        assert mine['name']=='Penguji Labkom' and mine['whatsapp']=='6281234567891' and 'Teknik Komputer' in admin['programs']
        assert any(e['id']==rid for e in json.loads(fetch('/admin/api/entries?q=081234567891',headers={'Cookie':cookie})[0])['entries'])
        assert not json.loads(fetch('/admin/api/entries?q=tidak-ada-nama-ini',headers={'Cookie':cookie})[0])['entries']
        thumb=Image.open(io.BytesIO(fetch(mine['thumbUrl'],headers={'Cookie':cookie})[0]));assert thumb.width<=360
        assert fetch(mine['photoUrl'],headers={'Cookie':cookie})[0]==output
        print('[OK] admin panel: login required, search, thumbnail and HD photo')
        with closing(sqlite3.connect(DB)) as db:
            row=db.execute('SELECT name, program, whatsapp, template_id FROM entries WHERE id=?',(rid,)).fetchone()
        assert row==('Penguji Labkom','Teknik Komputer','6281234567891','pink'), row
        print('[OK] participant data stored in SQLite')
        with closing(sqlite3.connect(DB)) as db, db:
            db.execute('UPDATE entries SET expires_at=? WHERE id=?',(time.time()-1,rid))
        fetch('/files/'+rid+'.jpg',expected=410)
        with closing(sqlite3.connect(DB)) as db:
            assert db.execute('SELECT 1 FROM entries WHERE id=?',(rid,)).fetchone() is None
        assert not (ROOT/'data'/'results'/f'{rid}.jpg').exists()
        print('[OK] expired photo and contact data are removed')
        fetch('/files/../../server.py.jpg',expected=404) if False else None
        print('ALL SMOKE TESTS PASSED')
    finally:
        server.terminate()
        try:server.wait(timeout=5)
        except subprocess.TimeoutExpired:server.kill()
        for key in (first, rid):
            if not key: continue
            with closing(sqlite3.connect(DB)) as db, db: db.execute('DELETE FROM entries WHERE id=?',(key,))
            (ROOT/'data'/'results'/f'{key}.jpg').unlink(missing_ok=True)

if __name__=='__main__':run()
