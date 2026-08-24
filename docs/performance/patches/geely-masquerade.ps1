<#
.SYNOPSIS
  对 2026AppMarketAIV5(avatr8678) 临时套用/还原「吉利身份伪装」补丁，用于在 avatr 车机上
  伪装成 geely L946 / GEELYGALAXY / channel=geely / 国家码 SA，走吉利生产/测试后端做性能测试。

  伪装内容（真实流程照常跑完、仅最终返回值替换，保证方法耗时准确）：
    region()->"SA"  brand()->"GEELYGALAXY"  model()/modelOnly()->"L946"  Constant.CHANNEL_FLAG->"geely"

  临时测试手段，不提交、不发布。补丁文件 geely-masquerade.patch 与本脚本同目录。

.PARAMETER Action
  apply : 套用伪装   revert : 还原(回 avatr 真实身份)   status : 查看(默认)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File geely-masquerade.ps1 apply
#>
param(
    [ValidateSet("apply", "revert", "status")]
    [string]$Action = "status"
)

# 注意: 不用 EAP=Stop —— git apply --check 失败时会写 stderr，PS5.1 会把原生命令 stderr 当终止错误。
$ErrorActionPreference = "Continue"

$RepoA = "D:\workspace\xsProjects\202605\AISdkV4\2026AppMarketAIV5"
$Patch = Join-Path $PSScriptRoot "geely-masquerade.patch"
$Files = @(
    "sample/app-market/src/avatr8678/java/com/appmarket/automotive/Avatr8678PlatformBridge.kt",
    "sample/app-market/src/avatr8678/java/com/appmarket/automotive/utils/Constant.kt"
)

if (-not (Test-Path $RepoA)) { Write-Host "工程A 不存在: $RepoA" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $Patch)) { Write-Host "补丁不存在: $Patch" -ForegroundColor Red; exit 1 }

# 用 LASTEXITCODE 判断(原生命令)：反向能 check 通过=已套用；正向能 check 通过=干净；都不行=冲突
function Get-State {
    & git -C $RepoA apply --reverse --check $Patch 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return "applied" }
    & git -C $RepoA apply --check $Patch 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return "clean" }
    return "conflict"
}

$state = Get-State

if ($Action -eq "status") {
    switch ($state) {
        "applied"  { Write-Host "状态: 已套用吉利伪装 (geely/L946/GEELYGALAXY/SA)" -ForegroundColor Yellow }
        "clean"    { Write-Host "状态: 未套用 (avatr 真实身份)" -ForegroundColor Green }
        "conflict" { Write-Host "状态: 无法判定 — 目标文件被手动改过，补丁正/反向都不匹配" -ForegroundColor Red }
    }
    exit 0
}

if ($Action -eq "apply") {
    if ($state -eq "applied") { Write-Host "已是套用状态，无需重复 apply" -ForegroundColor Yellow; exit 0 }
    if ($state -eq "conflict") { Write-Host "目标文件已被改动，补丁无法干净应用；请先 git checkout 还原后再试" -ForegroundColor Red; exit 1 }
    & git -C $RepoA apply $Patch 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "OK 已套用吉利伪装。测完用 revert 还原，且不要提交伪装改动。" -ForegroundColor Green }
    else { Write-Host "应用失败" -ForegroundColor Red; exit 1 }
    exit 0
}

if ($Action -eq "revert") {
    if ($state -eq "clean") { Write-Host "本就未套用，无需还原" -ForegroundColor Green; exit 0 }
    if ($state -eq "conflict") {
        Write-Host "补丁反向不匹配，改用 git checkout 还原两个目标文件" -ForegroundColor Yellow
        & git -C $RepoA checkout -- $Files[0] $Files[1] 2>$null
    } else {
        & git -C $RepoA apply --reverse $Patch 2>$null
    }
    if ($LASTEXITCODE -eq 0) { Write-Host "OK 已还原为 avatr 真实身份" -ForegroundColor Green }
    else { Write-Host "还原失败" -ForegroundColor Red; exit 1 }
    exit 0
}
