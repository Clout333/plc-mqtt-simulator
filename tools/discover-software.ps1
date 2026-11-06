$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$products = @(
    @{key='haiwell';role='plc';title='海为 HaiwellHappy';name='HaiwellHappy|海为.*PLC';process='^HaiwellHappy$';exe='HaiwellHappy.exe';folder='海为PLC'},
    @{key='haiwell';role='hmi';title='海为 Cloud SCADA';name='海为.*组态|Haiwell.*SCADA';process='^Scada\.(Develop|HMI|Runtime|CloudRuntime)$';exe='Scada.Develop.exe';folder='海为触摸屏'},
    @{key='tia';role='plc';title='西门子 TIA Portal / PLCSIM';name='TIA Portal|S7-PLCSIM|STEP 7 Professional';process='Siemens\.Automation\.Portal|^S7PLCSIM|^Siemens\.Simatic\.Simulation';exe='';folder=''},
    @{key='smart';role='plc';title='西门子 Micro/WIN SMART';name='Micro.?WIN.*SMART';process='^MWSmart$';exe='';folder=''},
    @{key='classic';role='plc';title='西门子 STEP 7-Micro/WIN';name='Micro.?WIN(?!.*SMART)';process='^microwin$';exe='';folder=''},
    @{key='mitsubishi';role='plc';title='三菱 GX Works';name='GX Works|GX Simulator';process='^GppW|^GXW3|^GXSimulator|^GX Works';exe='';folder=''},
    @{key='inovance';role='plc';title='汇川 AutoShop / InoProShop';name='AutoShop|InoProShop';process='^AutoShop|^InoProShop';exe='';folder=''},
    @{key='mcgs';role='hmi';title='昆仑通态 MCGS';name='MCGS|昆仑通态';process='^MCGS';exe='';folder=''},
    @{key='weintek';role='hmi';title='威纶通 EasyBuilder Pro';name='EasyBuilder Pro';process='^EasyBuilder Pro|^EasyBuilderPro|^EBPro$';exe='';folder=''}
)
$installed = @(Get-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Select-Object DisplayName,DisplayVersion)
$processes = @(Get-Process | Select-Object Id,ProcessName)
$found = @()
foreach($product in $products){
    $running = @($processes | Where-Object {$_.ProcessName -match $product.process})
    $matchesForProduct = @($installed | Where-Object {$_.DisplayName -match $product.name})
    $listed = $matchesForProduct.Count -gt 0
    $numericVersions = @($matchesForProduct.DisplayVersion | Where-Object {$_ -match '^\d{1,6}(\.\d{1,6}){0,3}$'} | Sort-Object -Unique)
    $version = if($numericVersions.Count -eq 1){$numericVersions[0]}else{''}
    $portable = $false
    if($product.exe){
        foreach($drive in [IO.DriveInfo]::GetDrives()){
            if($drive.DriveType -ne 'Fixed' -or -not $drive.IsReady){continue}
            $candidate = Join-Path (Join-Path $drive.RootDirectory.FullName $product.folder) $product.exe
            if([IO.File]::Exists($candidate)){$portable=$true;break}
        }
    }
    if($running.Count -or $listed -or $portable){
        $ports = @()
        foreach($proc in $running){
            $ports += @(Get-NetTCPConnection -State Listen -OwningProcess $proc.Id | Where-Object {$_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::'} | Select-Object -ExpandProperty LocalPort)
        }
        $found += [ordered]@{key=$product.key;role=$product.role;title=$product.title;running=($running.Count -gt 0);installed=$listed;portable=$portable;version=$version;ports=@($ports | Sort-Object -Unique | Select-Object -First 6)}
    }
}
[ordered]@{items=@($found)} | ConvertTo-Json -Depth 4 -Compress
