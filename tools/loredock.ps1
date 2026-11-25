param(
    [ValidateSet('Start', 'Stop')][string]$Action = 'Start',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot 'data\launcher'
$statePath = Join-Path $runtimeDirectory 'processes.json'
$frontendUrl = 'http://127.0.0.1:5173/'
$backendUrl = 'http://127.0.0.1:8000/api/health'
$tracked = @{}
$stateLoaded = $false
$createdNames = @()
$startupLock = $null
$http = $null
$exitCode = 0

function Save-ProcessState {
    $temporaryState = $statePath + '.tmp'
    $tracked | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryState -Encoding UTF8
    if (Test-Path -LiteralPath $statePath) {
        [System.IO.File]::Replace($temporaryState, $statePath, [NullString]::Value)
    } else { [System.IO.File]::Move($temporaryState, $statePath) }
}

function Get-TrackedProcess($record) {
    if ($null -eq $record) { return $null }
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    try {
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startedAt -and
            $process.Path -eq $record.executable) { return $process }
    } catch { return $null }
    return $null
}

function Stop-TrackedProcess($record) {
    $process = Get-TrackedProcess $record
    if ($null -eq $process) { return }
    # Match both creation time and executable before stopping this owned process tree.
    & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -and $null -ne (Get-TrackedProcess $record)) {
        throw "无法停止进程 $($record.id)，请稍后重试。"
    }
}

function Test-Healthy([string]$url, [string]$kind) {
    try {
        $content = $http.GetStringAsync($url).GetAwaiter().GetResult()
        if ($kind -eq 'frontend') {
            return $content.Contains('<title>LoreDock') -and $content.Contains('/src/main.tsx')
        }
        $health = $content | ConvertFrom-Json
        return $health.status -eq 'ok' -and $health.mode -eq 'keyword-index' -and $health.key_storage -eq 'windows-dpapi'
    } catch { return $false }
}

function Test-PortInUse([int]$port) {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return @($listeners | Where-Object { $_.Port -eq $port }).Count -gt 0
}

function Start-ServiceProcess([string]$name, [string]$executable, [string[]]$launchArguments, [string]$directory) {
    $stdout = Join-Path $runtimeDirectory "$name.stdout.log"
    $stderr = Join-Path $runtimeDirectory "$name.stderr.log"
    $process = Start-Process -FilePath $executable -ArgumentList $launchArguments `
        -WorkingDirectory $directory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $record = @{
        id = $process.Id
        startedAt = $process.StartTime.ToUniversalTime().Ticks.ToString()
        executable = $process.Path
    }
    $tracked[$name] = $record
    Save-ProcessState
    return $record
}

function Wait-Service([string]$url, [string]$kind, $record) {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 40) {
        if ($null -eq (Get-TrackedProcess $record)) {
            throw "$kind 启动后退出。请查看 $runtimeDirectory 中对应的 stderr.log。"
        }
        if (Test-Healthy $url $kind) { return }
        Start-Sleep -Milliseconds 400
    }
    throw "$kind 在 40 秒内未就绪。请查看 $runtimeDirectory 中的日志。"
}

try {
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    # Serialize double-clicks and stop/start operations across separate launcher windows.
    $lockTimer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($null -eq $startupLock) {
        try {
            $startupLock = [System.IO.File]::Open((Join-Path $runtimeDirectory 'launcher.lock'),
                [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch [System.IO.IOException] {
            if ($lockTimer.Elapsed.TotalSeconds -gt 45) { throw '另一个启动或停止操作仍在执行，请稍后重试。' }
            Start-Sleep -Milliseconds 300
        }
    }

    if (Test-Path -LiteralPath $statePath) {
        $saved = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($entry in $saved.PSObject.Properties) {
            if ($null -ne (Get-TrackedProcess $entry.Value)) { $tracked[$entry.Name] = $entry.Value }
        }
    }
    $stateLoaded = $true

    if ($Action -eq 'Stop') {
        foreach ($name in @($tracked.Keys)) {
            try {
                Stop-TrackedProcess $tracked[$name]
                $tracked.Remove($name)
            } catch {
                Write-Host $_.Exception.Message -ForegroundColor Red
                $exitCode = 1
            }
        }
        Save-ProcessState
        if ($exitCode -eq 0) { Write-Host '已停止由一键脚本启动的 LoreDock 服务。手动启动的服务不受影响。' }
    } else {
        Add-Type -AssemblyName System.Net.Http
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.UseProxy = $false
        $http = New-Object System.Net.Http.HttpClient($handler)
        $http.Timeout = [TimeSpan]::FromSeconds(2)

        $backendReady = Test-Healthy $backendUrl 'backend'
        $frontendReady = Test-Healthy $frontendUrl 'frontend'
        foreach ($target in @(@{ port = 8000; ready = $backendReady }, @{ port = 5173; ready = $frontendReady })) {
            if (-not $target.ready -and (Test-PortInUse $target.port)) {
                throw "端口 $($target.port) 已被占用，但服务未通过 LoreDock 检查。请确认占用程序后再试；脚本不会自动关闭它。"
            }
        }

        $python = Join-Path $projectRoot '.venv\Scripts\python.exe'
        $frontendDirectory = Join-Path $projectRoot 'frontend'
        $vite = Join-Path $frontendDirectory 'node_modules\vite\bin\vite.js'
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $backendReady -and -not (Test-Path -LiteralPath $python)) {
            throw '缺少项目 .venv，请先按 README 的首次安装说明准备环境。'
        }
        if (-not $frontendReady -and ($null -eq $node -or -not (Test-Path -LiteralPath $vite))) {
            throw '缺少 Node.js 或前端依赖，请按 README 安装 Node.js 并执行 npm --prefix frontend install。'
        }

        if (-not $backendReady) {
            Write-Host '正在启动后端…'
            $record = $tracked['backend']
            if ($null -eq $record) {
                $createdNames += 'backend'
                $record = Start-ServiceProcess 'backend' $python @('-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', '8000') $projectRoot
            }
            Wait-Service $backendUrl 'backend' $record
        } else { Write-Host '后端已在运行，继续使用。' }

        if (-not $frontendReady) {
            Write-Host '正在启动前端…'
            $record = $tracked['frontend']
            if ($null -eq $record) {
                $createdNames += 'frontend'
                $record = Start-ServiceProcess 'frontend' $node.Source @(('"' + $vite + '"'), '--host', '127.0.0.1', '--port', '5173', '--strictPort') $frontendDirectory
            }
            Wait-Service $frontendUrl 'frontend' $record
        } else { Write-Host '前端已在运行，继续使用。' }

        if (-not (Test-Healthy ($frontendUrl + 'api/health') 'backend')) {
            throw '前端已启动，但未能连接后端。请查看 data\launcher 中的日志。'
        }
        Save-ProcessState
        Write-Host "LoreDock 已就绪：$frontendUrl" -ForegroundColor Green
        Write-Host '服务将在后台运行。使用完毕后，双击“停止LoreDock.bat”。'
        if (-not $NoBrowser) {
            try { Start-Process -FilePath $frontendUrl | Out-Null }
            catch { Write-Host "未能自动打开浏览器，请手动访问 $frontendUrl" -ForegroundColor Yellow }
        }
    }
} catch {
    $exitCode = 1
    Write-Host $_.Exception.Message -ForegroundColor Red
    foreach ($name in $createdNames) {
        if (-not $tracked.ContainsKey($name)) { continue }
        try {
            Stop-TrackedProcess $tracked[$name]
            $tracked.Remove($name)
        } catch { Write-Host "未能清理 $name，请双击停止脚本重试。" -ForegroundColor Yellow }
    }
    if ($null -ne $startupLock -and $stateLoaded -and $createdNames.Count -gt 0) { Save-ProcessState }
} finally {
    if ($null -ne $http) { $http.Dispose() }
    if ($null -ne $startupLock) { $startupLock.Dispose() }
}

exit $exitCode
