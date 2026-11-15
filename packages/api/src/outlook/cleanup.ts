/** Graph's shared CLI consent must be compared before requesting setup privileges. */
export const outlookCleanupScript: string = String.raw`
function Invoke-KisunoGraph($method, $path, $body) {
    if (-not $path.StartsWith('/') -or $path.StartsWith('//')) { throw 'Ungültiger Graph-Pfad.' }
    $parameters = @{Method=$method;Uri=('https://graph.microsoft.com/v1.0'+$path);OutputType='PSObject'}
    if ($null -ne $body) { $parameters.Body=($body | ConvertTo-Json -Depth 20 -Compress);$parameters.ContentType='application/json' }
    Invoke-MgGraphRequest @parameters
}
function ConvertTo-KisunoScopes($value) {
    $items = @(($value -join ' ') -split '\s+' | Where-Object { $_ })
    foreach ($item in $items) {
        if ($item -notmatch '^[A-Za-z][A-Za-z0-9._]*$') { throw 'Der bestätigte Berechtigungsstand ist nicht eindeutig.' }
    }
    $items | Sort-Object -Unique -CaseSensitive
}
function Assert-KisunoIdentity($expected) {
    $context = Get-MgContext
    if ($context.AuthType -ne 'Delegated' -or $context.ContextScope -ne 'Process' -or $context.TenantId -cne $expected.TenantId -or $context.ClientId -cne $expected.ClientId) {
        throw 'Microsoft-Organisation oder Einrichtungsanwendung hat gewechselt. Es werden keine fremden Freigaben entfernt.'
    }
    $me = Invoke-KisunoGraph GET '/me?$select=id' $null
    if ($me.id -cne $expected.UserId) { throw 'Bitte während der gesamten Einrichtung dasselbe Administratorkonto verwenden. Es werden keine fremden Freigaben entfernt.' }
}
function Get-KisunoSetupGrants($clientId, $resourceId) {
    $path = '/oauth2PermissionGrants?$filter=clientId eq '+[Uri]::EscapeDataString("'"+$clientId+"'")
    for ($page=0; $page -lt 50; $page++) {
        $response = Invoke-KisunoGraph GET $path $null
        foreach ($row in $response.value) {
            if ($row.clientId -cne $clientId) { throw 'Die Graph-Bestandsantwort enthält eine fremde Anwendung.' }
            if ($row.resourceId -ceq $resourceId) { $row }
        }
        $next = $response.'@odata.nextLink'
        if (-not $next) { return }
        $uri = [Uri]$next
        if ($uri.Scheme -cne 'https' -or $uri.Host -cne 'graph.microsoft.com' -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Fragment -or $uri.AbsolutePath -cne '/v1.0/oauth2PermissionGrants') { throw 'Ungültige Graph-Folgeseite.' }
        $path = '/oauth2PermissionGrants'+$uri.Query
    }
    throw 'Zu viele Bestandsseiten. Die Bereinigung benötigt eine gezielte Prüfung.'
}
function Get-KisunoGrantFingerprint($row) {
    @($row.id,$row.clientId,$row.resourceId,$row.consentType,[string]$row.principalId,(@(ConvertTo-KisunoScopes $row.scope) -join ' ')) | ConvertTo-Json -Compress
}
function Save-KisunoSetupReceipt {
    $setupState | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -Path $setupReceipt
}
function Initialize-KisunoCleanupTargets {
    for ($attempt=0; $attempt -lt 6; $attempt++) {
        $setupState.Targets=@()
        $grants = @(Get-KisunoSetupGrants $setupState.ClientObjectId $setupState.ResourceId)
        foreach ($grant in $grants) {
            if (-not (($grant.consentType -ceq 'AllPrincipals' -and -not $grant.principalId) -or ($grant.consentType -ceq 'Principal' -and $grant.principalId -ceq $setupState.UserId))) { continue }
            $beforeScopes = @(ConvertTo-KisunoScopes $grant.scope)
            if (@($beforeScopes | Where-Object { $setupState.NewScopes -ccontains $_ }).Count -eq 0) { continue }
            $afterScopes = @($beforeScopes | Where-Object { $setupState.NewScopes -cnotcontains $_ })
            $setupState.Targets += [ordered]@{Before=$grant;Fingerprint=(Get-KisunoGrantFingerprint $grant);AfterScopes=$afterScopes;Submitted=$false}
        }
        $covered = @($setupState.Targets | ForEach-Object { ConvertTo-KisunoScopes $_.Before.scope })
        if (@($setupState.NewScopes | Where-Object { $covered -cnotcontains $_ }).Count -eq 0) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Die zusätzlichen Einrichtungsfreigaben sind noch nicht eindeutig sichtbar. Es wurde keine Kisuno-App erstellt; Bereinigungsbeleg prüfen.'
}
function Remove-KisunoAddedSetupPermissions {
    if ($setupState.NewScopes.Count -eq 0) { $setupState.Cleanup='Keine zusätzlichen Einrichtungsrechte';Save-KisunoSetupReceipt;return }
    Assert-KisunoIdentity $setupState
    $rows = @(Get-KisunoSetupGrants $setupState.ClientObjectId $setupState.ResourceId)
    foreach ($target in $setupState.Targets) {
        $current = @($rows | Where-Object { $_.id -ceq $target.Before.id })
        if ($current.Count -ne 1 -or (Get-KisunoGrantFingerprint $current[0]) -cne $target.Fingerprint) { throw 'Die Einrichtungsfreigabe wurde parallel verändert. Sie bleibt zur gezielten Prüfung erhalten.' }
    }
    foreach ($target in $setupState.Targets) {
        $current = @(Get-KisunoSetupGrants $setupState.ClientObjectId $setupState.ResourceId | Where-Object { $_.id -ceq $target.Before.id })
        if ($current.Count -ne 1 -or (Get-KisunoGrantFingerprint $current[0]) -cne $target.Fingerprint) { throw 'Die Einrichtungsfreigabe wurde parallel verändert. Die Bereinigung wurde angehalten.' }
        $path = '/oauth2PermissionGrants/'+[Uri]::EscapeDataString($target.Before.id)
        if ($target.AfterScopes.Count -eq 0) {
            Invoke-KisunoGraph DELETE $path $null | Out-Null
        } else {
            Invoke-KisunoGraph PATCH $path @{scope=($target.AfterScopes -join ' ')} | Out-Null
        }
        $target.Submitted=$true
        Save-KisunoSetupReceipt
    }
    for ($attempt=0; $attempt -lt 6; $attempt++) {
        $rows = @(Get-KisunoSetupGrants $setupState.ClientObjectId $setupState.ResourceId)
        $verified = $true
        foreach ($target in $setupState.Targets) {
            $current = @($rows | Where-Object { $_.id -ceq $target.Before.id })
            if ($target.AfterScopes.Count -eq 0) {
                if ($current.Count -ne 0) { $verified=$false }
            } elseif ($current.Count -ne 1 -or (@(ConvertTo-KisunoScopes $current[0].scope) -join ' ') -cne ($target.AfterScopes -join ' ')) {
                $verified=$false
            }
        }
        if ($verified) { $setupState.Cleanup='Zusätzliche Einrichtungsrechte entfernt und geprüft';Save-KisunoSetupReceipt;return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Microsoft hat die Bereinigung noch nicht bestätigt. Die Registrierung und der Bereinigungsbeleg bleiben erhalten; keine vollständige Erfolgsmeldung.'
}
`;
