import { outlookCleanupScript } from './cleanup';

/** The only private value in the downloaded result is encrypted for this server. */
export function outlookRegistrationScript(input: {
  id: string;
  publicKey: string;
  redirectUri: string;
}): string {
  const payload = Buffer.from(JSON.stringify(input)).toString('base64');
  return `# Kisuno Outlook registration. PowerShell 7 and Microsoft.Graph.Authentication (MIT).
# Creates one NEW dedicated application. Existing applications remain unchanged.
$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Bitte PowerShell 7 verwenden.' }
Import-Module Microsoft.Graph.Authentication
${outlookCleanupScript}
if (Get-MgContext) { throw 'Bitte die Registrierung in einem neuen PowerShell-7-Prozess ausführen. Eine andere bestehende Anmeldung bleibt erhalten.' }
$setupReceipt = Join-Path (Get-Location) ('kisuno-outlook-'+$config.id+'-bereinigung.txt')
$setupState = $null
$cleanupPrepared = $false
$registrationCreated = $false
$setupFailure = $null
try {
    Write-Host 'Bestandsaufnahme: mit demselben Microsoft-Administratorkonto anmelden. Zuerst wird nur das eigene Profil angefragt.'
    Connect-MgGraph -Scopes 'User.Read' -ContextScope Process -NoWelcome
    $initial = Get-MgContext
    if ($initial.AuthType -ne 'Delegated' -or $initial.ContextScope -ne 'Process' -or $initial.TenantId -notmatch '^[0-9a-fA-F-]{36}$' -or $initial.ClientId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Die persönliche Microsoft-Anmeldung ist nicht eindeutig.' }
    $me = Invoke-KisunoGraph GET '/me?$select=id' $null
    $setupState = [ordered]@{Version=1;RegistrationId=$config.id;TenantId=$initial.TenantId;ClientId=$initial.ClientId;UserId=$me.id;NewScopes=@();Targets=@();Cleanup='Bestandsaufnahme';ClientObjectId=$null;ResourceId=$null}
    Disconnect-MgGraph | Out-Null
    # User.Read establishes consent for Graph before .default is requested.
    # Microsoft documents that .default then returns all previously granted scopes.
    Connect-MgGraph -TenantId $setupState.TenantId -ClientId $setupState.ClientId -Scopes 'https://graph.microsoft.com/.default' -ContextScope Process -NoWelcome
    Assert-KisunoIdentity $setupState
    $baseline = @(ConvertTo-KisunoScopes (Get-MgContext).Scopes)
    if ($baseline -cnotcontains 'User.Read') { throw 'Die vollständige Bestandsaufnahme wurde nicht bestätigt; keine Einrichtungsrechte werden angefragt.' }
    $setupScopes = @('Application.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All')
    $setupState.NewScopes = @($setupScopes | Where-Object { $baseline -cnotcontains $_ })
    $setupState.BaselineScopes = $baseline
    Save-KisunoSetupReceipt
    if ($setupState.NewScopes.Count -gt 0) {
        Disconnect-MgGraph | Out-Null
        Write-Host 'Einrichtungszustimmung: erneut dasselbe Administratorkonto verwenden. Vorhandene Berechtigungen bleiben erhalten.'
        Connect-MgGraph -TenantId $setupState.TenantId -ClientId $setupState.ClientId -Scopes $setupState.NewScopes -ContextScope Process -NoWelcome
        Connect-MgGraph -TenantId $setupState.TenantId -ClientId $setupState.ClientId -Scopes 'https://graph.microsoft.com/.default' -ContextScope Process -NoWelcome
        Assert-KisunoIdentity $setupState
    }
    $currentScopes = @(ConvertTo-KisunoScopes (Get-MgContext).Scopes)
    if (@($setupScopes | Where-Object { $currentScopes -cnotcontains $_ }).Count -ne 0) { throw 'Microsoft hat die Einrichtungsrechte nicht bestätigt.' }
    $graph = (Invoke-KisunoGraph GET "/servicePrincipals?\u0060$filter=appId eq '00000003-0000-0000-c000-000000000000'" $null).value | Select-Object -First 1
    $setupClient = (Invoke-KisunoGraph GET ('/servicePrincipals?$filter=appId eq '+[Uri]::EscapeDataString("'"+$setupState.ClientId+"'")) $null).value
    if (@($setupClient).Count -ne 1 -or $setupClient[0].appId -cne $setupState.ClientId) { throw 'Die Einrichtungsanwendung ist nicht eindeutig.' }
    $setupState.ClientObjectId = $setupClient[0].id
    $setupState.ResourceId = $graph.id
    Initialize-KisunoCleanupTargets
    $cleanupPrepared = $true
    $setupState.Cleanup = 'Zusätzliche Einrichtungsrechte erfasst'
    Save-KisunoSetupReceipt
    $name = 'Kisuno Outlook '+$config.id
    $existing = (Invoke-KisunoGraph GET ('/applications?$filter=displayName eq '+[Uri]::EscapeDataString("'"+$name+"'")) $null).value
    if ($existing.Count) { throw 'Diese Registrierung wurde bereits erstellt. Bitte die vorhandene verschluesselte Registrierungsdatei importieren.' }
    $permissions = @()
    foreach ($scope in @('openid','profile','offline_access','User.Read','Mail.Read','Mail.Read.Shared','Calendars.Read','Calendars.Read.Shared')) {
        $permission = $graph.oauth2PermissionScopes | Where-Object { $_.value -eq $scope -and $_.isEnabled } | Select-Object -First 1
        if (-not $permission) { throw ('Delegiertes Leserecht fehlt: '+$scope) }
        $permissions += @{id=$permission.id;type='Scope'}
    }
    $app = Invoke-KisunoGraph POST '/applications' @{
        displayName=$name; signInAudience='AzureADMyOrg'
        web=@{redirectUris=@($config.redirectUri)}
        requiredResourceAccess=@(@{resourceAppId=$graph.appId;resourceAccess=$permissions})
    }
    $principal = Invoke-KisunoGraph POST '/servicePrincipals' @{appId=$app.appId}
    Invoke-KisunoGraph POST '/oauth2PermissionGrants' @{clientId=$principal.id;consentType='AllPrincipals';resourceId=$graph.id;scope='openid profile offline_access User.Read Mail.Read Mail.Read.Shared Calendars.Read Calendars.Read.Shared'} | Out-Null
    $expires = [DateTime]::UtcNow.AddDays(180).ToString('o')
    $credential = Invoke-KisunoGraph POST ('/applications/'+$app.id+'/addPassword') @{passwordCredential=@{displayName='Kisuno delegiertes Outlook';endDateTime=$expires}}
    $rsa = [Security.Cryptography.RSA]::Create()
    try {
        $rsa.ImportFromPem($config.publicKey)
        $ciphertext = [Convert]::ToBase64String($rsa.Encrypt([Text.Encoding]::UTF8.GetBytes($credential.secretText),[Security.Cryptography.RSAEncryptionPadding]::OaepSHA256))
    } finally { $rsa.Dispose() }
    $result = @{registrationId=$config.id;tenantId=(Get-MgContext).TenantId;clientId=$app.appId;ciphertext=$ciphertext;expiresAt=$expires}
    $file = Join-Path (Get-Location) ('kisuno-outlook-'+$config.id+'.json')
    $result | ConvertTo-Json | Set-Content -Encoding utf8 -Path $file
    $credential = $null
    $registrationCreated = $true
    Write-Host ('Verschluesselte Registrierung gespeichert: '+$file)
} catch {
    $setupFailure = $_
} finally {
    $credential=$null
    try {
        if ($cleanupPrepared) {
            try { Remove-KisunoAddedSetupPermissions }
            catch {
                $setupFailure = $_
                $setupState.Cleanup = 'Nicht vollständig bestätigt'
                Save-KisunoSetupReceipt
                Write-Warning ('Bereinigung nicht vollständig bestätigt. Beleg: '+$setupReceipt)
            }
        } elseif ($null -ne $setupState -and $setupState.NewScopes.Count -gt 0) {
            Write-Warning ('Einrichtungsrechte konnten nicht eindeutig zugeordnet werden. Keine fremden Freigaben wurden entfernt. Beleg: '+$setupReceipt)
        }
    } finally {
        if (Get-MgContext) { Disconnect-MgGraph | Out-Null }
    }
}
if ($null -ne $setupFailure) { throw $setupFailure }
if (-not $registrationCreated) { throw 'Die Registrierung wurde nicht vollständig erstellt.' }
Write-Host ('Registrierung erfolgreich. '+$setupState.Cleanup+'. Bereits vorhandene Rechte bleiben erhalten.')
Write-Host 'Die verschlüsselte Registrierungsdatei im Kisuno-Adminportal importieren; jede Person verbindet danach ihr eigenes Konto.'
`;
}
