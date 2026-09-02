$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Read-EnvFile($Path) {
  $envMap = @{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $envMap }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $envMap[$name] = $value
  }
  return $envMap
}

$envMap = Read-EnvFile (Join-Path $repoRoot ".env.local")

if (-not $env:CLOUDFLARE_API_TOKEN -and $envMap["CLOUDFLARE_API_TOKEN"]) {
  $env:CLOUDFLARE_API_TOKEN = $envMap["CLOUDFLARE_API_TOKEN"]
}

# Wrangler supports either an explicit scoped API token or its encrypted OAuth
# session. Leave the token unset when the operator has already run
# `wrangler login`; Wrangler will still fail closed if neither is available.
if (-not $env:CLOUDFLARE_API_TOKEN) {
  Write-Host "No Cloudflare API token supplied; using the existing Wrangler OAuth session."
}

$projectName = if ($envMap["CLOUDFLARE_PAGES_PROJECT"]) { $envMap["CLOUDFLARE_PAGES_PROJECT"] } else { "paddle-rage-pickleball" }
$branchName = if ($envMap["CLOUDFLARE_PAGES_BRANCH"]) { $envMap["CLOUDFLARE_PAGES_BRANCH"] } else { "main" }

$publicFiles = @(
  "_headers",
  "_worker.js",
  "admin.html",
  "availability-graphic.css",
  "availability-graphic.js",
  "brand-theme.css",
  "payment-method-brand.css",
  "payment-method-brand.js",
  "assets/payment-methods/gcash.png",
  "assets/payment-methods/bdo-pay.png",
  "assets/payment-methods/maya.png",
  "assets/payment-methods/bpi.png",
  "assets/payment-methods/gotyme.png",
  "assets/payment-methods/maribank.png",
  "assets/payment-methods/pnb.png",
  "assets/payment-methods/cash.svg",
  "booking-balance.js",
  "host-balance-payment.js",
  "host-balance-admin.js",
  "owner-insights.js",
  "owner-insights.css",
  "chart.min.js",
  "host.html",
  "index.html",
  "linkimage.jpg",
  "paddleragelogo.jpg",
  "paddleragelogo-transparent.png",
  "paddle-rage-grunge-edge.png",
  "paddle-rage-word-paddle.png",
  "paddle-rage-word-rage.png",
  "login.html",
  "finance-core.js",
  "open-play-rating.js",
  "play-manager.css",
  "play-manager.js",
  "player-live.css",
  "player-live.html",
  "player-live.js",
  "qrcode-LICENSE.txt",
  "qrcode.min.js",
  "supabase-config.js",
  "supabase.min.js",
  "splash-music.mp3"
)

$stagingDir = Join-Path $repoRoot ".cf-pages-deploy"
if (Test-Path -LiteralPath $stagingDir) {
  Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDir | Out-Null

foreach ($file in $publicFiles) {
  $source = Join-Path $repoRoot $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Required Pages asset is missing: $file"
  }
  $destination = Join-Path $stagingDir $file
  $destinationDir = Split-Path -Parent $destination
  if (-not (Test-Path -LiteralPath $destinationDir -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

$wranglerCli = Get-Command "wrangler.cmd" -CommandType Application -ErrorAction SilentlyContinue
if (-not $wranglerCli) {
  $wranglerCli = Get-Command "wrangler" -CommandType Application -ErrorAction SilentlyContinue
}
$npxCli = Get-Command "npx.cmd" -CommandType Application -ErrorAction SilentlyContinue
if (-not $wranglerCli -and -not $npxCli) {
  throw "Wrangler is unavailable. Install Wrangler or Node.js/npx first."
}

Push-Location $repoRoot
try {
  if ($wranglerCli) {
    & $wranglerCli.Source pages deploy $stagingDir --project-name $projectName --branch $branchName
  } else {
    & $npxCli.Source wrangler pages deploy $stagingDir --project-name $projectName --branch $branchName
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare Pages deploy failed with exit code $LASTEXITCODE."
  }
  Write-Host "Cloudflare Pages deployed."
} finally {
  Pop-Location
}
