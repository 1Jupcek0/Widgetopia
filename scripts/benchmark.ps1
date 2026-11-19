<#
.SYNOPSIS
  Measures what Widgetopia costs: CPU, memory and GPU of the app and its WebView2 processes in several scenarios.

.DESCRIPTION
  Starts the given build, switches the panels / options through the WebView2 remote-debugging port, lets
  every scenario settle and then samples the whole process tree (the app plus all WebView2 child processes).

  Use a SEPARATE build with its own identifier so your own layout is not touched (see "Tests" in the README):
    cd src-tauri
    $env:TAURI_CONFIG='{"identifier":"dev.widgetopia.test"}'; $env:CARGO_TARGET_DIR="target-test"
    cargo build --release

.EXAMPLE
  powershell -File scripts\benchmark.ps1 -Exe src-tauri\target-test\release\widgetopia.exe
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 45,      # sampling time per scenario
  [int]$Settle = 10,       # wait after switching a scenario
  [int]$Port = 9223
)

$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required (it drives the app over the debugging port).' }

# --- tiny DevTools client ---------------------------------------------------------------------
$helper = Join-Path $env:TEMP 'widgetopia-cdp.js'
@"
const http = require('http'), fs = require('fs');
http.get('http://127.0.0.1:$Port/json', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => {
  const t = JSON.parse(d).find(x => x.type === 'page'); const ws = new WebSocket(t.webSocketDebuggerUrl);
  ws.onmessage = e => { const m = JSON.parse(e.data); console.log(JSON.stringify(m.result && m.result.result ? m.result.result.value : m)); process.exit(0); };
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: fs.readFileSync(process.argv[2], 'utf8'), awaitPromise: true, returnByValue: true } }));
}); }).on('error', () => { console.log('null'); process.exit(0); });
"@ | Set-Content $helper -Encoding utf8

function Invoke-Page([string]$js) {
  $f = Join-Path $env:TEMP 'widgetopia-eval.js'
  Set-Content $f $js -Encoding utf8
  node $helper $f
}

function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($rootPid)
  for ($i = 0; $i -lt $ids.Count; $i++) {
    foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $ids[$i] }) { if (-not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }
  }
  $ids
}

function Measure-Scenario([string]$name, [string]$js, [int]$appPid) {
  Invoke-Page $js | Out-Null
  Start-Sleep -Seconds $Settle
  $ids = Get-Tree $appPid
  $t0 = Get-Date
  $cpu0 = @{}; foreach ($i in $ids) { $p = Get-Process -Id $i -ErrorAction SilentlyContinue; if ($p) { $cpu0[$i] = $p.TotalProcessorTime.TotalSeconds } }

  # GPU: per engine type, summed over our processes; the busiest engine type counts (as Task Manager does)
  $gpuSamples = @()
  $end = $t0.AddSeconds($Seconds)
  while ((Get-Date) -lt $end) {
    try {
      $c = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples | Where-Object {
        $_.InstanceName -match 'pid_(\d+)_' -and $ids -contains [int]$Matches[1] }
      $byType = $c | Group-Object { ($_.InstanceName -replace '.*engtype_', '') } | ForEach-Object { ($_.Group | Measure-Object CookedValue -Sum).Sum }
      $gpuSamples += [double](($byType | Measure-Object -Maximum).Maximum)
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  $elapsed = ((Get-Date) - $t0).TotalSeconds
  $cpu = 0.0; $ws = 0.0; $priv = 0.0
  foreach ($i in $ids) {
    $p = Get-Process -Id $i -ErrorAction SilentlyContinue
    if ($p) { if ($cpu0.ContainsKey($i)) { $cpu += $p.TotalProcessorTime.TotalSeconds - $cpu0[$i] }; $ws += $p.WorkingSet64; $priv += $p.PrivateMemorySize64 }
  }
  $cores = [Environment]::ProcessorCount
  [pscustomobject]@{
    Scenario   = $name
    CpuOneCore = [math]::Round($cpu / $elapsed * 100, 1)
    CpuTotal   = [math]::Round($cpu / $elapsed / $cores * 100, 2)
    RamMB      = [math]::Round($ws / 1MB)
    PrivateMB  = [math]::Round($priv / 1MB)
    GpuPercent = [math]::Round((($gpuSamples | Measure-Object -Average).Average), 1)
    Processes  = $ids.Count
  }
}

# --- start the app ----------------------------------------------------------------------------
Get-CimInstance Win32_Process -Filter "Name='widgetopia.exe'" | Where-Object { $_.ExecutablePath -eq $Exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 1
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$app = Start-Process $Exe -PassThru
Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
for ($i = 0; $i -lt 40; $i++) { Start-Sleep 1; if ((Invoke-Page '1') -ne 'null') { break } }
Start-Sleep 5

$allPanels = '"clock","weather","media","system","perf","notes","timer","clipboard","herdr","claude","launcher","calendar"'
$reset = 'state.enabled={}; state.opts={}; state.glass.icons=false; state.front=false; setFront(false); applyEnabled(); applyTheme(); applyLayout(); 1'

$scenarios = @(
  @{ n = 'Default layout (6 panels)';                 js = "$reset" },
  @{ n = 'Default layout, Solid style';               js = "$reset; setOpt('theme','style','solid'); 1" },
  @{ n = 'All 12 panels on';                          js = "$reset; for (const id of [$allPanels]) state.enabled[id]=true; applyEnabled(); setOpt('clipboard','record',true); 1" },
  @{ n = 'Default + bring to front (live capture)';   js = "$reset; setFront(true); invoke('raise_overlay'); 1" },
  @{ n = 'Default + glass sees desktop icons';        js = "$reset; state.glass.icons=true; applyCaptureSettings(); 1" },
  @{ n = 'Everything off (idle floor)';               js = "$reset; for (const id of [$allPanels]) state.enabled[id]=false; applyEnabled(); 1" }
)

# The first minute after start-up is not representative (wallpaper decoding, first weather request, ...): warm up first.
Write-Host "Warming up ..." -ForegroundColor DarkGray
Invoke-Page $scenarios[0].js | Out-Null
Start-Sleep -Seconds 40

$results = foreach ($s in $scenarios) {
  Write-Host ("Measuring: " + $s.n) -ForegroundColor Cyan
  Measure-Scenario $s.n $s.js $app.Id
}

Invoke-Page "$reset" | Out-Null
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue

$cpuName = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name.Trim()
$gpuName = (Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|AMD|Radeon|Intel' } | Select-Object -First 1).Name
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$os = (Get-CimInstance Win32_OperatingSystem).Caption
Write-Host ""
Write-Host "Machine: $cpuName ($([Environment]::ProcessorCount) threads), $ram GB RAM, $gpuName, $os"
Write-Host "Sampling: $Seconds s per scenario after $Settle s settling, release build, nothing on screen moving."
Write-Host ""
$results | Format-Table Scenario, CpuOneCore, CpuTotal, RamMB, GpuPercent, Processes -AutoSize
$results | ConvertTo-Json | Set-Content (Join-Path $env:TEMP 'widgetopia-benchmark.json') -Encoding utf8
Write-Host ("Raw numbers: " + (Join-Path $env:TEMP 'widgetopia-benchmark.json'))
