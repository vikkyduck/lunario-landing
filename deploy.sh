#!/usr/bin/env bash
# lunario.online — деплой лендинга (А/Б) + бэкенда заявок на Timeweb VDS.
# Запуск: ./deploy.sh
# Первичная инфраструктура (systemd-юнит, nginx, certbot, .env) ставится один раз —
# см. deploy/SETUP.md. Этот скрипт: заливает site/ и backend/ и перезапускает сервис.
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

echo "==> site/ → /opt/lunario/site"
rsync -az --delete site/ "$SERVER:/opt/lunario/site/"

echo "==> backend/ → /opt/lunario/backend (без .env — он в /opt/lunario/.env)"
rsync -az --delete --exclude='.env' backend/ "$SERVER:/opt/lunario/backend/"

echo "==> перезапуск lunario-api + health"
ssh "$SERVER" 'systemctl restart lunario-api && sleep 1 && echo -n "health: " && curl -sS http://127.0.0.1:5030/api/health && echo'

echo "==> проверка сайта"
curl -sS -o /dev/null -w "site HTTPS %{http_code}\n" "https://lunario.online/" || true
echo "✅ Готово: https://lunario.online/"
