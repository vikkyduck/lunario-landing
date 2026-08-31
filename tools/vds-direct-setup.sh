#!/bin/bash
# Прямой доступ к сайтам на Timeweb VDS (5.129.198.180) в обход VPN-туннеля.
# Ставит маршрут «к серверу — через физическую сеть» и LaunchDaemon,
# который восстанавливает его после перезагрузки, смены Wi-Fi и переподключения VPN.
# Покрывает все сайты на этом сервере: lunario.online, withoutwater.ru,
# psy3107.ru, vi-utkina.ru (у них один IP).
# Запуск: sudo bash vds-direct-setup.sh    Откат: sudo bash vds-direct-setup.sh remove
set -euo pipefail

VDS=5.129.198.180
HELPER=/usr/local/libexec/vds-direct.sh
PLIST=/Library/LaunchDaemons/ru.utkina.vds-direct.plist
LABEL=ru.utkina.vds-direct

if [ "${1:-}" = "remove" ]; then
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$HELPER"
  route -n delete "$VDS" >/dev/null 2>&1 || true
  echo "Обход удалён: трафик к серверу снова идёт как весь остальной."
  exit 0
fi

mkdir -p /usr/local/libexec

cat > "$HELPER" <<'EOF'
#!/bin/bash
# Прописывает маршрут к VDS через шлюз физической сети (мимо utun-туннелей).
VDS=5.129.198.180
for IF in $(ifconfig -l | tr ' ' '\n' | grep -E '^en[0-9]+$'); do
  GW=$(route -n get default -ifscope "$IF" 2>/dev/null | awk '/gateway:/{print $2}')
  if [ -n "$GW" ]; then
    route -n delete "$VDS" >/dev/null 2>&1
    route -n add "$VDS" "$GW" >/dev/null 2>&1
    exit 0
  fi
done
exit 0
EOF
chmod 755 "$HELPER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HELPER</string></array>
  <key>RunAtLoad</key><true/>
  <key>WatchPaths</key><array><string>/Library/Preferences/SystemConfiguration</string></array>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF

launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
launchctl kickstart "system/$LABEL"
sleep 1
echo "— маршрут к серверу сейчас:"
route -n get "$VDS" | grep -E "interface|gateway" || true
echo "Готово. Сайты на VDS ходят напрямую, остальной трафик — через VPN как раньше."
