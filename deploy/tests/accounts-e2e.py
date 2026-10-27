#!/usr/bin/env python3
"""Isolated auth + gateway + app smoke test. Requires built server packages and local runtime images."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse

root = Path(__file__).resolve().parents[2]
work = Path(tempfile.mkdtemp(prefix='moa-accounts-e2e-'))
project = 'moa-acct-test-' + work.name.rsplit('-', 1)[-1]
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
origin = f'http://localhost:{port}'
for directory in ['config','auth-data','app-data','media']:
    (work/directory).mkdir(mode=0o777)
    (work/directory).chmod(0o777)
work.chmod(0o755)
salt = b'test-only-salt'
verifier = hashlib.scrypt(b'admin-password', salt=salt, n=32768, r=8, p=1, maxmem=64*1024*1024, dklen=64).hex()
(work/'config/credentials.json').write_text(json.dumps({'csrfSecret':'test-only-secret','users':[{'username':'admin','salt':salt.hex(),'hash':verifier}]}))
conf = (root/'deploy/gateway/default.conf.template').read_text()
for key, value in {'PUBLIC_HOST': 'localhost', 'PUBLIC_SCHEME': 'http', 'GATEWAY_CLIENT_IP': '$remote_addr'}.items():
    conf = conf.replace('${' + key + '}', value)
(work/'gateway.conf').write_text(conf)
# Use separate test containers; mount compiled source code over existing runtime images.
services = {
 'moa': {'image':'moa-moa:latest','environment':{'MOA_REQUIRE_ACCOUNT':'1','MOA_SCAN_INTERVAL_MS':'0','MOA_TMDB_TOKEN':'','MOA_TMDB_API_KEY':''},
   'volumes':[f'{root}/apps/server/dist:/app/apps/server/dist:ro',f'{work}/app-data:/data',f'{work}/media:/media:ro']},
 'moa-auth': {'image':'moa-moa-auth:latest','environment':{'PUBLIC_ORIGIN':origin},'volumes':[f'{root}/deploy/auth:/app:ro',f'{work}/config:/config:ro',f'{work}/auth-data:/data']},
 'gateway': {'image':'nginx:1.27-alpine','ports':[f'127.0.0.1:{port}:8080'],'volumes':[f'{work}/gateway.conf:/etc/nginx/conf.d/default.conf:ro'],'depends_on':['moa','moa-auth']},
}
compose = work/'compose.json'; compose.write_text(json.dumps({'services':services}))
command = ['docker','compose','--project-name',project,'--file',str(compose)]
class Client:
    def __init__(self): self.cookies = {}
    def request(self, path, method='GET', data=None, form=False, headers=None):
        argv = ['curl','--silent','--show-error','--max-time','20','--dump-header',str(work/'headers'),'--output',str(work/'body'),'--write-out','%{http_code}','-X',method,origin+path]
        h = {'Cookie': '; '.join(f'{k}={v}' for k,v in self.cookies.items())}
        if data is not None:
            h.update({'Origin':origin,'Content-Type':'application/x-www-form-urlencoded' if form else 'application/json','X-Moa-Request':'1'})
            argv += ['--data-binary',urllib.parse.urlencode(data) if form else json.dumps(data)]
        h.update(headers or {})
        for k,v in h.items(): argv += ['-H',f'{k}: {v}']
        status = int(subprocess.check_output(argv, text=True))
        for k,v in re.findall(r'^Set-Cookie: ([^=]+)=([^;\r\n]*)', (work/'headers').read_text(), re.M | re.I):
            if v: self.cookies[k] = v
            else: self.cookies.pop(k, None)
        return status,(work/'body').read_text()
    def api(self,path,method='GET',data=None,headers=None):
        status,body=self.request(path,method,data,headers=headers)
        try: result = json.loads(body) if body else None
        except json.JSONDecodeError: result = body
        return status,result
    def submit(self,kind,fields):
        status,page=self.request('/__moa/'+kind)
        assert status == 200
        csrf=re.search(r'name="csrf" value="([^"]+)"',page)[1]
        return self.request('/__moa/'+kind,'POST',{'csrf':csrf,**fields},form=True)
try:
    subprocess.run(command+['up','-d'],check=True,stdout=subprocess.DEVNULL)
    for attempt in range(40):
        try:
            if Client().request('/__moa/login')[0] == 200: break
        except subprocess.CalledProcessError: pass
        time.sleep(0.5)
    admin, member = Client(), Client()
    assert member.api('/api/me',headers={'X-Moa-Account':'forged','X-Moa-Role':'admin'})[0] == 401
    assert admin.submit('login',{'username':'admin','password':'admin-password'})[0] == 303
    for attempt in range(40):
        status,a = admin.api('/api/me')
        if status == 200: break
        time.sleep(0.5)
    assert status == 200 and a['role'] == 'admin', (status,a)
    status,ap = admin.api('/api/profiles','POST',{'name':'Admin','avatar':'cat-1'}); assert status == 201
    status,invite = admin.api('/__moa/api/invites','POST',{'maxUses':1,'expiresInDays':1}); assert status == 201
    assert member.submit('join',{'code':invite['code'],'username':'member','password':'member-password','confirm':'member-password'})[0] == 303
    status,m = member.api('/api/me',headers={'X-Moa-Account':a['id'],'X-Moa-Role':'admin','X-Moa-Username':'forged'})
    assert status == 200 and m['role'] == 'member' and m['id'] != a['id'] and m['username'] == 'member'
    assert member.api('/api/profiles')[1] == []
    status,mp = member.api('/api/profiles','POST',{'name':'Member','avatar':'robot-2'}); assert status == 201
    assert member.api('/api/profiles/'+ap['id'],'PATCH',{'name':'stolen'})[0] == 404
    assert member.api('/api/settings',headers={'X-Moa-Profile':ap['id']})[0] == 401
    assert member.api('/api/settings','PATCH',{'autoplayDelay':17},headers={'X-Moa-Profile':mp['id']})[0] == 200
    assert admin.api('/api/settings',headers={'X-Moa-Profile':ap['id']})[1]['autoplayDelay'] == 5
    assert member.api('/api/library/scan','POST',{},headers={'X-Moa-Profile':mp['id'],'X-Moa-Role':'admin'}) == (403,{'error':'admin-required'})
    assert member.api('/%61pi/library/scan','POST',{},headers={'X-Moa-Profile':mp['id']}) == (403,{'error':'admin-required'})
    assert member.api('/__moa/api/accounts')[0] == 403
    assert admin.api('/__moa/api/invites')[1][0]['status'] == 'used-up'
    assert admin.api('/__moa/api/accounts/'+m['id'],'DELETE',{})[0] == 204
    assert member.api('/api/me')[0] == 401
    assert admin.api('/api/admin/accounts/'+m['id']+'/data','DELETE')[0] == 204
    assert admin.api('/api/profiles')[1][0]['id'] == ap['id']
    print('PASS: curl invite → join → account/profile/settings isolation → spoofed headers blocked → admin 403 → delete/revoke/cleanup')
finally:
    subprocess.run(command+['down','--volumes','--remove-orphans'],check=True,stdout=subprocess.DEVNULL)
    shutil.rmtree(work)
