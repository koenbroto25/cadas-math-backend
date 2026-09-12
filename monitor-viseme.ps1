# monitor-viseme.ps1 — sample tiap 60s selama 5 menit, tulis ke file log
# Detached: tahan walaupun sesi tool/command timeout.
$cache = 'D:\local-rag-voice-bot\speed-math-master\audio\speech\cache\visemes'
$log = 'D:\local-rag-voice-bot\cadas-app-backend\viseme-monitor.log'
"timestamp,rhubarb_alive,total_json,delta_60s" | Out-File $log -Encoding utf8
$prev = (Get-ChildItem $cache -File | Measure-Object).Count
for ($i = 0; $i -lt 5; $i++) {
  Start-Sleep -Seconds 60
  $r = (Get-Process rhubarb -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count)
  $t = (Get-ChildItem $cache -File | Measure-Object).Count
  $delta = $t - $prev
  $prev = $t
  "$(Get-Date -Format HH:mm:ss),$r,$t,$delta" | Out-File -Append $log -Encoding utf8
}
"monitor_selesai" | Out-File -Append $log -Encoding utf8
