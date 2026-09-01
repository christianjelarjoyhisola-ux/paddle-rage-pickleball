[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $repoRoot ".env.local"

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

function Resolve-ConfigValue($Name, $EnvMap, [switch]$Required) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if (-not $value -and $EnvMap.ContainsKey($Name)) { $value = $EnvMap[$Name] }
  $value = [string]$value
  if ($Required -and [string]::IsNullOrWhiteSpace($value)) {
    throw "Set $Name in the environment or $envFile."
  }
  return $value.Trim()
}

$envMap = Read-EnvFile $envFile
$accessToken = Resolve-ConfigValue "SUPABASE_ACCESS_TOKEN" $envMap -Required
$projectRef = Resolve-ConfigValue "SUPABASE_PROJECT_REF" $envMap -Required
$serviceRoleKey = Resolve-ConfigValue "SUPABASE_SERVICE_ROLE_KEY" $envMap -Required
$databasePassword = Resolve-ConfigValue "SUPABASE_DB_PASSWORD" $envMap
$googleVisionKey = Resolve-ConfigValue "GOOGLE_VISION_API_KEY" $envMap
$paymentProvider = Resolve-ConfigValue "PAYMENT_PROVIDER" $envMap
if (-not $paymentProvider) { $paymentProvider = "template" }
$paymentWebhookSecret = Resolve-ConfigValue "PAYMENT_WEBHOOK_SECRET" $envMap
$publicLogoUrl = Resolve-ConfigValue "PUBLIC_LOGO_URL" $envMap
$appAdminUrl = Resolve-ConfigValue "APP_ADMIN_URL" $envMap
$appPublicUrl = Resolve-ConfigValue "APP_PUBLIC_URL" $envMap
$emailAllowedOrigins = Resolve-ConfigValue "EMAIL_ALLOWED_ORIGINS" $envMap
$mailerooApiKey = Resolve-ConfigValue "MAILEROO_API_KEY" $envMap
$mailerooFromAddress = Resolve-ConfigValue "MAILEROO_FROM_ADDRESS" $envMap
$mailerooFromName = Resolve-ConfigValue "MAILEROO_FROM_NAME" $envMap
$mailerooReplyTo = Resolve-ConfigValue "MAILEROO_REPLY_TO" $envMap
$telegramBotToken = Resolve-ConfigValue "TELEGRAM_BOT_TOKEN" $envMap
$telegramChatId = Resolve-ConfigValue "TELEGRAM_CHAT_ID" $envMap

if ($paymentProvider -eq "paymongo" -and -not $paymentWebhookSecret) {
  throw "PAYMENT_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=paymongo."
}

if (($mailerooApiKey -and -not $mailerooFromAddress) -or ($mailerooFromAddress -and -not $mailerooApiKey)) {
  throw "MAILEROO_API_KEY and MAILEROO_FROM_ADDRESS must be configured together."
}

if (($telegramBotToken -and -not $telegramChatId) -or ($telegramChatId -and -not $telegramBotToken)) {
  throw "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured together."
}

if ($projectRef -notmatch '^[a-z0-9]{20}$') {
  throw "SUPABASE_PROJECT_REF must be the 20-character project reference, not a URL."
}

# The CLI reads this variable directly. Never print token or secret values.
$env:SUPABASE_ACCESS_TOKEN = $accessToken
if ($databasePassword) { $env:SUPABASE_DB_PASSWORD = $databasePassword }

$script:SupabaseCli = Get-Command "supabase" -ErrorAction SilentlyContinue
$script:NpxCli = Get-Command "npx.cmd" -CommandType Application -ErrorAction SilentlyContinue
if (-not $script:SupabaseCli -and -not $script:NpxCli) {
  throw "Supabase CLI is unavailable. Install supabase or Node.js/npx first."
}

function Invoke-Supabase {
  if ($script:SupabaseCli) {
    & $script:SupabaseCli.Source @args
  } else {
    & $script:NpxCli.Source supabase @args
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase CLI failed with exit code $LASTEXITCODE."
  }
}

function Invoke-SupabaseCapture {
  if ($script:SupabaseCli) {
    $output = & $script:SupabaseCli.Source @args
  } else {
    $output = & $script:NpxCli.Source supabase @args
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase CLI failed with exit code $LASTEXITCODE."
  }
  return ($output | Out-String)
}

Push-Location $repoRoot
try {
  $supabaseConfig = Join-Path $repoRoot "supabase\config.toml"
  if (-not (Test-Path -LiteralPath $supabaseConfig -PathType Leaf)) {
    Write-Host "Initializing local Supabase CLI configuration..."
    Invoke-Supabase init
  }

  Write-Host "Target Supabase project: $projectRef"
  Invoke-Supabase link --project-ref $projectRef

  # A deploy may intentionally rely on encrypted secrets that are already in
  # Supabase instead of copying them into .env.local. Fail closed unless every
  # production integration secret is either supplied now or exists remotely.
  $secretListJson = Invoke-SupabaseCapture secrets list --project-ref $projectRef --output json
  try {
    $secretList = $secretListJson | ConvertFrom-Json
  } catch {
    throw "Could not parse the Supabase secret inventory. No deployment was attempted."
  }
  $secretRows = if ($secretList.PSObject.Properties.Name -contains "secrets") {
    @($secretList.secrets)
  } else {
    @($secretList)
  }
  $remoteSecretNames = @($secretRows | ForEach-Object { [string]$_.name })
  $requiredIntegrationSecrets = @(
    @{ Name = "GOOGLE_VISION_API_KEY"; Value = $googleVisionKey },
    @{ Name = "MAILEROO_API_KEY"; Value = $mailerooApiKey },
    @{ Name = "MAILEROO_FROM_ADDRESS"; Value = $mailerooFromAddress },
    @{ Name = "MAILEROO_FROM_NAME"; Value = $mailerooFromName },
    @{ Name = "MAILEROO_REPLY_TO"; Value = $mailerooReplyTo },
    @{ Name = "APP_PUBLIC_URL"; Value = $appPublicUrl },
    @{ Name = "APP_ADMIN_URL"; Value = $appAdminUrl },
    @{ Name = "PUBLIC_LOGO_URL"; Value = $publicLogoUrl },
    @{ Name = "EMAIL_ALLOWED_ORIGINS"; Value = $emailAllowedOrigins },
    @{ Name = "TELEGRAM_BOT_TOKEN"; Value = $telegramBotToken },
    @{ Name = "TELEGRAM_CHAT_ID"; Value = $telegramChatId }
  )
  foreach ($requiredSecret in $requiredIntegrationSecrets) {
    if ([string]::IsNullOrWhiteSpace([string]$requiredSecret.Value) -and
        $remoteSecretNames -notcontains [string]$requiredSecret.Name) {
      throw "Required production secret $($requiredSecret.Name) is neither configured remotely nor supplied locally."
    }
  }

  # Functions in this repository depend on the newest booking/host columns and
  # RLS policies. Stop immediately if migrations fail; deploying functions
  # against an older schema can break approvals and host reservations.
  Write-Host "Applying database migrations before Edge Functions..."
  Invoke-Supabase db push --dry-run
  Invoke-Supabase db push

  $secretArgs = @(
    "secrets", "set",
    "SERVICE_ROLE_KEY=$serviceRoleKey",
    "PAYMENT_PROVIDER=$paymentProvider"
  )
  if ($googleVisionKey) { $secretArgs += "GOOGLE_VISION_API_KEY=$googleVisionKey" }
  if ($paymentWebhookSecret) { $secretArgs += "PAYMENT_WEBHOOK_SECRET=$paymentWebhookSecret" }
  if ($publicLogoUrl) { $secretArgs += "PUBLIC_LOGO_URL=$publicLogoUrl" }
  if ($appAdminUrl) { $secretArgs += "APP_ADMIN_URL=$appAdminUrl" }
  if ($appPublicUrl) { $secretArgs += "APP_PUBLIC_URL=$appPublicUrl" }
  if ($emailAllowedOrigins) { $secretArgs += "EMAIL_ALLOWED_ORIGINS=$emailAllowedOrigins" }
  if ($mailerooApiKey) { $secretArgs += "MAILEROO_API_KEY=$mailerooApiKey" }
  if ($mailerooFromAddress) { $secretArgs += "MAILEROO_FROM_ADDRESS=$mailerooFromAddress" }
  if ($mailerooFromName) { $secretArgs += "MAILEROO_FROM_NAME=$mailerooFromName" }
  if ($mailerooReplyTo) { $secretArgs += "MAILEROO_REPLY_TO=$mailerooReplyTo" }
  if ($telegramBotToken) { $secretArgs += "TELEGRAM_BOT_TOKEN=$telegramBotToken" }
  if ($telegramChatId) { $secretArgs += "TELEGRAM_CHAT_ID=$telegramChatId" }
  Invoke-Supabase @secretArgs

  $functions = @(
    "create-payment-session",
    "payment-webhook",
    "verify-gcash-receipt",
    "host-booking-balance-payment",
    "host-application",
    "manage-account",
    "send-confirmation-email",
    "send-booking-status-email",
    "process-host-balance-deadlines",
    "send-reschedule-email",
    "send-telegram-notification",
    "submit-public-registration",
    "submit-public-booking",
    "integration-status"
  )

  # Only third-party/server callbacks that cannot present a Supabase JWT stay
  # outside the gateway JWT check. Each of these functions must enforce its
  # own provider/shared-secret authentication internally.
  $noJwtFunctions = @(
    "payment-webhook",
    "process-host-balance-deadlines"
  )

  foreach ($functionName in $functions) {
    if ($noJwtFunctions -contains $functionName) {
      Invoke-Supabase functions deploy $functionName --no-verify-jwt
    } else {
      Invoke-Supabase functions deploy $functionName
    }
  }

  Write-Host "Database migrations and Edge Functions deployed successfully."
} finally {
  Pop-Location
}
