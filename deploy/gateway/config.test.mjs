import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('gateway catches dynamic hosts and forwards normalized scheme on auth subrequests', () => {
  const config = readFileSync(new URL('./default.conf.template', import.meta.url), 'utf8');
  assert.match(config, /listen 8080 default_server;/);
  assert.match(config, /map \$http_x_forwarded_proto \$moa_proto/);
  for (const location of ['location = /__moa/check', 'location @login', 'location / {']) {
    const block = config.slice(config.indexOf(location)).split('\n  }')[0];
    assert.match(block, /proxy_set_header X-Forwarded-Proto \$moa_proto;/);
    assert.match(block, /proxy_set_header Host \$http_host;/);
    assert.match(block, /proxy_set_header X-Real-IP \$\{GATEWAY_CLIENT_IP\};/);
  }
  assert.match(config, /auth_request \/__moa\/check;/);
  assert.match(config, /proxy_set_header X-Moa-Account \$moa_account;/);
  assert.match(config, /auth_request_set \$moa_permissions \$upstream_http_x_moa_permissions;/);
  assert.match(config, /proxy_set_header X-Moa-Permissions \$moa_permissions;/);
  assert.match(config, /proxy_set_header X-Moa-Permissions "";/);
});
