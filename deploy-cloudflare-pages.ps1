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
$defaultTurnstileSiteKey = "0x4AAAAAAD4nzq_UBKjDttlu"
$turnstileSiteKey = if ($env:TURNSTILE_SITE_KEY) { $env:TURNSTILE_SITE_KEY.Trim() } elseif ($envMap["TURNSTILE_SITE_KEY"]) { $envMap["TURNSTILE_SITE_KEY"].Trim() } else { $defaultTurnstileSiteKey }
if (-not $turnstileSiteKey -or $turnstileSiteKey -match '^YOUR_|TURNSTILE_SITE_KEY') {
  $turnstileSiteKey = $defaultTurnstileSiteKey
}

$publicFiles = @(
  "_headers",
  "_worker.js",
  "admin.html",
  "brand-theme.css",
  "booking-balance.js",
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
  "runtime-config.js",
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
  Copy-Item -LiteralPath $source -Destination $stagingDir -Force
}

# Generate only public browser configuration in the staging directory. JSON
# encoding prevents a malformed key from becoming executable JavaScript.
$turnstileSiteKeyJson = ConvertTo-Json -InputObject $turnstileSiteKey -Compress
$runtimeConfig = "window.PB_PUBLIC_CONFIG = Object.freeze({ turnstileSiteKey: $turnstileSiteKeyJson });"
Set-Content -LiteralPath (Join-Path $stagingDir "runtime-config.js") -Value $runtimeConfig -Encoding utf8

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
