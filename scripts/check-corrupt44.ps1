$files = @(
'L10_P2_023_hint','L10_P2_028_hint','L10_P2_045_hint','L10_P2_049_hint','L10_P2_050_hint',
'L10_P2_059_hint','L10_P2_061_hint','L10_P2_062_hint','L10_P2_086_hint','L10_P2_087_hint',
'L10_P2_098_hint','L10_P3_015_trick','L10_P3_073_trick','L10_P3_074_trick','L10_P3_080_trick',
'L11_P2_039_trick','L11_P2_043_trick','L11_P2_054_trick','L11_P2_085_trick','L12_P1_072_hint',
'L15_P4_035_hint','L15_P4_084_hint','L1_P1_075_hint','L1_P1_188_hint','L1_P1_190_hint',
'L1_P1_224_hint','L1_P1_238_hint','L1_P1_239_hint','L1_P1_242_hint','l2_lvl2_020_hint',
'L4_P1_033_hint','L4_P1_035_trick','L4_P1_038_hint','L4_P1_041_trick','L5_P1_041_trick',
'L5_P1_066_trick','L5_P1_071_trick','L5_P1_080_trick','L5_P1_098_trick','L5_P1_099_trick',
'L5_P4_068_hint','L6_P1_049_hint','L9_P5_052_hint','L9_P5_091_hint'
)
$c = 'D:\local-rag-voice-bot\speed-math-master\audio\speech\cache'
$ErrorActionPreference = 'SilentlyContinue'
$missing = 0; $corrupt = 0; $ok = 0
foreach ($f in $files) {
  $p = Join-Path $c "$f.wav"
  if (-not (Test-Path $p)) { $missing++; Write-Output "MISSING: $f"; continue }
  $null = & ffprobe -v error -i $p 2>$null
  if ($LASTEXITCODE -ne 0) { $corrupt++; Write-Output "CORRUPT: $f" } else { $ok++; Write-Output "OK: $f" }
}
Write-Output "SUMMARY: total=$($files.Count) ok=$ok corrupt=$corrupt missing=$missing"