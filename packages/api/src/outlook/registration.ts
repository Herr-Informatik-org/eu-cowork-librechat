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
Connect-MgGraph -Scopes 'Application.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All' -ContextScope Process -NoWelcome
try {
    function Graph($method, $path, $body) {
        $args = @{Method=$method; Uri=('https://graph.microsoft.com/v1.0'+$path); OutputType='PSObject'}
        if ($null -ne $body) { $args.Body=($body | ConvertTo-Json -Depth 20 -Compress); $args.ContentType='application/json' }
        Invoke-MgGraphRequest @args
    }
    $name = 'Kisuno Outlook '+$config.id
    $existing = (Graph GET ("/applications?\u0060$filter=displayName eq '"+$name+"'") $null).value
    if ($existing.Count) { throw 'Diese Registrierung wurde bereits erstellt. Bitte die vorhandene verschluesselte Registrierungsdatei importieren.' }
    $graph = (Graph GET "/servicePrincipals?\u0060$filter=appId eq '00000003-0000-0000-c000-000000000000'" $null).value | Select-Object -First 1
    $permissions = @()
    foreach ($scope in @('openid','profile','offline_access','User.Read','Mail.Read','Mail.Read.Shared','Calendars.Read','Calendars.Read.Shared')) {
        $permission = $graph.oauth2PermissionScopes | Where-Object { $_.value -eq $scope -and $_.isEnabled } | Select-Object -First 1
        if (-not $permission) { throw ('Delegiertes Leserecht fehlt: '+$scope) }
        $permissions += @{id=$permission.id;type='Scope'}
    }
    $app = Graph POST '/applications' @{
        displayName=$name; signInAudience='AzureADMyOrg'
        web=@{redirectUris=@($config.redirectUri)}
        requiredResourceAccess=@(@{resourceAppId=$graph.appId;resourceAccess=$permissions})
    }
    $principal = Graph POST '/servicePrincipals' @{appId=$app.appId}
    Graph POST '/oauth2PermissionGrants' @{clientId=$principal.id;consentType='AllPrincipals';resourceId=$graph.id;scope='openid profile offline_access User.Read Mail.Read Mail.Read.Shared Calendars.Read Calendars.Read.Shared'} | Out-Null
    $expires = [DateTime]::UtcNow.AddDays(180).ToString('o')
    $credential = Graph POST ('/applications/'+$app.id+'/addPassword') @{passwordCredential=@{displayName='Kisuno delegiertes Outlook';endDateTime=$expires}}
    $rsa = [Security.Cryptography.RSA]::Create()
    try {
        $rsa.ImportFromPem($config.publicKey)
        $ciphertext = [Convert]::ToBase64String($rsa.Encrypt([Text.Encoding]::UTF8.GetBytes($credential.secretText),[Security.Cryptography.RSAEncryptionPadding]::OaepSHA256))
    } finally { $rsa.Dispose() }
    $result = @{registrationId=$config.id;tenantId=(Get-MgContext).TenantId;clientId=$app.appId;ciphertext=$ciphertext;expiresAt=$expires}
    $file = Join-Path (Get-Location) ('kisuno-outlook-'+$config.id+'.json')
    $result | ConvertTo-Json | Set-Content -Encoding utf8 -Path $file
    Write-Host ('Verschluesselte Registrierung gespeichert: '+$file)
    Write-Host 'Diese Datei im Kisuno-Adminportal importieren Die einmalige Microsoft-Freigabe ist erfolgt; jede Person verbindet danach ihr eigenes Konto.'
} finally { $credential=$null; Disconnect-MgGraph | Out-Null }
`;
}
