$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$program = Join-Path $projectRoot 'release\win-unpacked\LoreDock.exe'
if (-not (Test-Path -LiteralPath $program)) { throw '请先打包 LoreDock 桌面版。' }
$shortcutShell = New-Object -ComObject WScript.Shell
$locations = @($projectRoot, [Environment]::GetFolderPath('Desktop')) | Select-Object -Unique
foreach ($location in $locations) {
    $target = Join-Path $location 'LoreDock.lnk'
    if (Test-Path -LiteralPath $target) {
        $existing = $shortcutShell.CreateShortcut($target)
        if ($existing.TargetPath -ne $program) { throw "同名快捷方式已存在，未覆盖：$target" }
    }
    $shortcut = $shortcutShell.CreateShortcut($target)
    $shortcut.TargetPath = $program
    $shortcut.WorkingDirectory = Split-Path -Parent $program
    $shortcut.IconLocation = Join-Path $projectRoot 'desktop\assets\loredock.ico'
    $shortcut.Description = 'LoreDock 个人知识工作台'
    $shortcut.Save()
    Write-Output $target
}
