# Requires Administrator.
# Keep the USB cable plugged for power. Disable USB data so this MediaTek
# clone can charge. Wi-Fi ADB stays up for the agent.
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'enable-phone-charging.log'
function Log([string]$message) {
    Add-Content -Path $log -Value $message
    Write-Output $message
}
Set-Content -Path $log -Value ('started ' + (Get-Date).ToString('o') + ' as ' + ([Security.Principal.WindowsIdentity]::GetCurrent().Name))
$phoneData = 'USB\VID_0E8D&PID_201C\0123456789ABCDEF'
$phoneCharge = 'USB\VID_0E8D&PID_20FF\0123456789ABCDEF'

Log 'Disabling USB hub power saving...'
Get-CimInstance -Namespace root\wmi -ClassName MSPower_DeviceEnable |
    Where-Object { $_.InstanceName -match 'VID_174C|VID_0E8D|ROOT_HUB30' } |
    ForEach-Object {
        try {
            $_.Enable = $false
            Set-CimInstance -CimInstance $_
            Log ('  off ' + $_.InstanceName)
        } catch {
            Log ('  fail ' + $_.InstanceName + ' :: ' + $_.Exception.Message)
        }
    }

Log 'Disabling USB data on the phone (charge-only)...'
$pnputilOut = & pnputil.exe /disable-device $phoneData 2>&1 | Out-String
Log $pnputilOut.Trim()
try {
    Disable-PnpDevice -InstanceId $phoneData -Confirm:$false
    Log '  Disable-PnpDevice ok'
} catch {
    Log ('  Disable-PnpDevice: ' + $_.Exception.Message)
}

Start-Sleep -Seconds 2
$enableOut = & pnputil.exe /enable-device $phoneCharge 2>&1 | Out-String
Log ('charge HID: ' + $enableOut.Trim())

Log 'USB devices now:'
Get-PnpDevice | Where-Object { $_.InstanceId -match 'VID_0E8D' } |
    ForEach-Object { Log ('  {0} | {1} | {2}' -f $_.Status, $_.FriendlyName, $_.InstanceId) }
Log 'done'
