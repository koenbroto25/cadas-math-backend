#!/usr/bin/env bash
set -euo pipefail
# Run as root after deploy-vm-app.sh has completed successfully.
test -s /var/www/cadas/backend/src/index.js
test -s /var/www/cadas/frontend/dist/index.html
test -s /home/cadas-app/cadas-runtime.env
install -o cadas-app -g cadas-app -m 600 /home/cadas-app/cadas-runtime.env /var/www/cadas/backend/.env
rm /home/cadas-app/cadas-runtime.env
cat > /etc/systemd/system/cadas-backend.service <<'SERVICE'
[Unit]
Description=CADAS Express backend
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=cadas-app
Group=cadas-app
WorkingDirectory=/var/www/cadas/backend
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node src/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
MemoryMax=1G

[Install]
WantedBy=multi-user.target
SERVICE
cat > /etc/nginx/sites-available/cadas <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name cadasmatematika.web.id www.cadasmatematika.web.id;
    root /var/www/cadas/frontend/dist;
    index index.html;
    server_tokens off;
    client_max_body_size 10m;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    gzip on;
    gzip_types application/javascript application/json text/css image/svg+xml;

    location ~ /\. { deny all; }
    location = /server.js { return 404; }
    location = /package.json { return 404; }
    location = /vercel.json { return 404; }
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 150s;
    }
    location /d/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /audio/ {
        return 302 https://audio.cadasmatematika.web.id$request_uri;
    }
    location = /index.html { add_header Cache-Control "no-cache"; }
    location = /manifest.json { add_header Cache-Control "no-cache"; }
    location /_expo/ { try_files $uri =404; expires 1y; }
    location /assets/ { try_files $uri =404; expires 1d; }
    location / { try_files $uri $uri/ /index.html; }
}
NGINX
# Only remove Ubuntu's default site, not unrelated sites.
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/cadas /etc/nginx/sites-enabled/cadas
nginx -t
systemctl daemon-reload
systemctl enable --now cadas-backend
systemctl reload nginx
sleep 5
systemctl is-active cadas-backend
curl --fail --max-time 20 http://127.0.0.1:3000/api/health
