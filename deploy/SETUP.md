# lunario.online — первичная установка на Timeweb VDS (выполняется один раз)

Сервер: root@5.129.198.180 (тот же, что withoutwater/kotu/vi-utkina).
Повторные выкатки после установки — просто `./deploy.sh` из корня проекта.

## 1. Каталоги и код

```bash
ssh root@5.129.198.180 'mkdir -p /opt/lunario/{site,backend,data}'
rsync -az site/ root@5.129.198.180:/opt/lunario/site/
rsync -az --exclude='.env' backend/ root@5.129.198.180:/opt/lunario/backend/
```

## 2. .env с секретами (на сервере)

```bash
ssh root@5.129.198.180
cp /opt/lunario/backend/.env.example /opt/lunario/.env
# ADMIN_PASS: openssl rand -base64 18  → вписать в /opt/lunario/.env
# METRIKA_ID: номер счётчика Метрики
chmod 600 /opt/lunario/.env
chown -R www-data:www-data /opt/lunario/data
```

## 3. systemd

```bash
cp /opt/lunario/backend/lunario-api.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now lunario-api
curl -s http://127.0.0.1:5030/api/health
```

## 4. DNS (панель timeweb.cloud)

A-записи: `lunario.online` → 5.129.198.180, `www.lunario.online` → 5.129.198.180.
Проверка: `dig +short lunario.online` должен вернуть 5.129.198.180.

## 5. nginx + HTTPS

```bash
cp /opt/lunario/backend/../deploy/nginx-lunario.conf /etc/nginx/sites-available/lunario  # либо scp из репо
ln -s /etc/nginx/sites-available/lunario /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d lunario.online -d www.lunario.online
```

(До выпуска сертификата ssl-блоки в конфиге закомментировать либо начать с 80-порта.)

## 6. Telegram-бот

Бота создаёт владелица у @BotFather → токен вводится на сервере:
`bash /opt/lunario/backend/set-tg.sh` (спросит токен и chat_id, перезапустит сервис).
chat_id личного чата: написать боту любое сообщение, затем
`curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[0-9]*' | head -1`.
Если api.telegram.org с VDS не отвечает — вписать в .env TELEGRAM_API_BASE
(CF-прокси, как в finance-duck).

## 7. Метрика

Счётчик на lunario.online создаёт владелица (metrika.yandex.ru) → номер в
/opt/lunario/.env (METRIKA_ID=…) → `systemctl restart lunario-api`.
Цели создать в интерфейсе Метрики: тип «JavaScript-событие» с идентификаторами
lead_sent (главная), cta_click, form_start. А/Б-вариант приходит параметром ab_variant.

## 8. Бэкапы

```bash
cat >/etc/cron.d/lunario-backup <<'EOF'
30 3 * * * root mkdir -p /opt/lunario/backups && sqlite3 /opt/lunario/data/lunario.db ".backup /opt/lunario/backups/lunario-$(date +\%F).db" && ls -t /opt/lunario/backups/lunario-*.db | tail -n +31 | xargs -r rm
EOF
```

(Если sqlite3-клиента нет: `apt install -y sqlite3`.)
