#!/usr/bin/env bash
set -euo pipefail
cd /var/www/cadas
[ -d backend/.git ] || git clone --branch main https://github.com/koenbroto25/cadas-math-backend.git backend
[ -d frontend/.git ] || git clone --branch main https://github.com/koenbroto25/cadas-math-web.git frontend
cd backend
git pull --ff-only origin main
npm ci --omit=dev --no-audit --no-fund
cd ../frontend
git pull --ff-only origin main
npm ci --no-audit --no-fund
EXPO_NO_DOTENV=1 EXPO_PUBLIC_API_URL='' CI=1 npm run build:web
