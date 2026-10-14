param(
    [string]$SillyTavernRoot = 'D:\programming\SillyTavern',
    [string]$UserHandle = 'default-user'
)

$ErrorActionPreference = 'Stop'
$extensionSource = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$extensionsDirectory = Join-Path $SillyTavernRoot "data\$UserHandle\extensions"
if (-not (Test-Path -LiteralPath $extensionsDirectory -PathType Container)) {
    throw "ST 扩展目录不存在：$extensionsDirectory"
}
$extensionPath = Join-Path $extensionsDirectory 'st-image-hub'
if (Test-Path -LiteralPath $extensionPath) {
    $existing = Get-Item -LiteralPath $extensionPath
    if ($existing.LinkType -ne 'Junction' -or $existing.Target -ne $extensionSource) {
        throw "扩展安装路径已被其他目录占用：$extensionPath"
    }
    Write-Output "开发目录已连接：$extensionPath"
    return
}
New-Item -ItemType Junction -Path $extensionPath -Target $extensionSource | Out-Null
Write-Output "已连接 $extensionPath -> $extensionSource。关闭旧的 image2 酒馆助手脚本，刷新 ST 页面。"
