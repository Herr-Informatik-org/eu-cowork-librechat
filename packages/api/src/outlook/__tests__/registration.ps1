param([string]$Registration,[string]$Fixture,[string]$Output)
$ErrorActionPreference='Stop'
$script:inputData=Get-Content -Raw $Fixture | ConvertFrom-Json
$script:authContext=$null
$script:connects=@()
$script:writes=@()
$script:grantRows=@($script:inputData.grants)
$script:created=$false
$script:disconnected=0
$script:mutated=$false
$script:grantReads=0
$script:failed=$null
$script:succeeded=$false
$tenant='11111111-1111-4111-8111-111111111111'
$client='66666666-6666-4666-8666-666666666666'
$clientObject='77777777-7777-4777-8777-777777777777'
$resource='99999999-9999-4999-8999-999999999999'
$user='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function Import-Module([string]$Name) { if($Name -cne 'Microsoft.Graph.Authentication'){throw 'Unexpected module'} }
function Start-Sleep([int]$Milliseconds) {}
function Get-MgContext { $script:authContext }
function Disconnect-MgGraph { $script:authContext=$null;$script:disconnected++ }
function Connect-MgGraph([string[]]$Scopes,[string]$ContextScope,[string]$TenantId,[string]$ClientId,[switch]$NoWelcome) {
    $script:connects+=,@($Scopes)
    if($Scopes -contains 'https://graph.microsoft.com/.default') {
        $scopesOut=@($script:grantRows | Where-Object { $_.clientId -ceq $clientObject -and $_.resourceId -ceq $resource -and ($_.consentType -ceq 'AllPrincipals' -or $_.principalId -ceq $user) } | ForEach-Object { $_.scope -split '\s+' } | Sort-Object -Unique)
        if($script:inputData.ambiguousBaseline -and $script:connects.Count -eq 2){$scopesOut=@('.default')}
    } else {
        $type=if($script:inputData.globalConsent -and $Scopes -cnotcontains 'User.Read'){'AllPrincipals'}else{'Principal'}
        $row=@($script:grantRows | Where-Object { $_.clientId -ceq $clientObject -and $_.resourceId -ceq $resource -and $_.consentType -ceq $type -and ($type -ceq 'AllPrincipals' -or $_.principalId -ceq $user) }) | Select-Object -First 1
        if(-not $row){
            $row=[pscustomobject]@{id=('new-'+$type);clientId=$clientObject;resourceId=$resource;consentType=$type;principalId=$(if($type -ceq 'Principal'){$user}else{$null});scope=''}
            $script:grantRows+=,$row
        }
        $row.scope=(@(($row.scope -split '\s+')+$Scopes) | Where-Object{$_} | Sort-Object -Unique) -join ' '
        $scopesOut=@($row.scope -split '\s+')
    }
    $script:authContext=[pscustomobject]@{AuthType='Delegated';ContextScope=$ContextScope;TenantId=$tenant;ClientId=$client;Scopes=$scopesOut}
    if($script:inputData.switchTenant -and $script:connects.Count -eq 2){$script:authContext.TenantId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}
}
function Invoke-MgGraphRequest([string]$Method,[string]$Uri,$Body,[string]$ContentType,[string]$OutputType) {
    $uriObject=[Uri]$Uri
    if($uriObject.Host -cne 'graph.microsoft.com'){throw 'Unexpected remote host'}
    $path=$uriObject.AbsolutePath.Replace('/v1.0','')
    $query=[Uri]::UnescapeDataString($uriObject.Query)
    $bodyObject=if($null -ne $Body){$Body | ConvertFrom-Json}else{$null}
    if($Method -cne 'GET'){$script:writes+=,[pscustomobject]@{method=$Method;path=$path;body=$bodyObject}}
    if($Method -ceq 'GET' -and $path -ceq '/me'){return @{id=$user}}
    if($Method -ceq 'GET' -and $path -ceq '/servicePrincipals'){
        if($query.Contains($client)){return @{value=@(@{id=$clientObject;appId=$client})}}
        $permissions=@();$i=1
        foreach($scope in @('openid','profile','offline_access','User.Read','Mail.Read','Mail.Read.Shared','Calendars.Read','Calendars.Read.Shared')){
            $permissions+=@{id=('00000000-0000-4000-8000-'+$i.ToString('000000000000'));value=$scope;isEnabled=$true};$i++
        }
        return @{value=@(@{id=$resource;appId='00000003-0000-0000-c000-000000000000';oauth2PermissionScopes=$permissions})}
    }
    if($Method -ceq 'GET' -and $path -ceq '/oauth2PermissionGrants'){
        if($script:created -and $script:inputData.concurrentChange -and -not $script:mutated){
            ($script:grantRows | Where-Object { $_.clientId -ceq $clientObject -and $_.principalId -ceq $user } | Select-Object -First 1).scope+=' Group.Read.All'
            $script:mutated=$true
        }
        $rows=@($script:grantRows | Where-Object { $_.clientId -ceq $clientObject })
        $script:grantReads++
        if(-not $script:created -and $script:grantReads -le $script:inputData.snapshotDelay){
            $rows=@($rows | ConvertTo-Json -Depth 12 | ConvertFrom-Json)
            foreach($row in $rows){$row.scope=(@($row.scope -split '\s+' | Where-Object{$_ -cnotin @('Application.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All')}) -join ' ')}
        }
        if($script:inputData.evilNext){return @{value=$rows;'@odata.nextLink'='https://evil.invalid/v1.0/oauth2PermissionGrants'}}
        return @{value=$rows}
    }
    if($Method -ceq 'GET' -and $path -ceq '/applications'){return @{value=@()}}
    if($Method -ceq 'POST' -and $path -ceq '/applications'){
        $script:created=$true
        return @{id='33333333-3333-4333-8333-333333333333';appId='22222222-2222-4222-8222-222222222222'}
    }
    if($Method -ceq 'POST' -and $path -ceq '/servicePrincipals'){return @{id='44444444-4444-4444-8444-444444444444'}}
    if($Method -ceq 'POST' -and $path -ceq '/oauth2PermissionGrants'){return @{id='kisuno-mail-consent'}}
    if($Method -ceq 'POST' -and $path.EndsWith('/addPassword')){
        if($script:inputData.creationFailure){throw 'Fixture application creation failure'}
        return @{secretText='fixture-only-password'}
    }
    if($path.StartsWith('/oauth2PermissionGrants/') -and $Method -cin @('PATCH','DELETE')){
        if($script:inputData.cleanupFailure){throw 'Fixture cleanup denied'}
        $id=[Uri]::UnescapeDataString($path.Split('/')[-1]);$row=@($script:grantRows | Where-Object{$_.id -ceq $id})
        if($row.Count -ne 1){throw 'Unexpected grant ID'}
        if($Method -ceq 'PATCH'){$row[0].scope=$bodyObject.scope}else{$script:grantRows=@($script:grantRows | Where-Object{$_.id -cne $id})}
        return
    }
    throw ('Unexpected fixture operation: '+$Method+' '+$path)
}
try { . $Registration;$script:succeeded=$true } catch { $script:failed=$_.Exception.Message }
finally {
    @{succeeded=$script:succeeded;failure=$script:failed;grants=@($script:grantRows);writes=@($script:writes);connects=@($script:connects);disconnected=$script:disconnected;sessionEnded=($null -eq $script:authContext)} | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $Output
}
