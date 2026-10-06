# Requires Administrator.
# This MediaTek clone will not charge while Windows keeps the USB data
# device (I15 Pro Max / WinUSB). Removing or disabling that device in
# Device Manager is what starts charging. The cable stays plugged.
# Wi-Fi ADB is unaffected. Do not touch the charge-only HID (PID_20FF).
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'enable-phone-charging.log'
function Log([string]$message) {
    Add-Content -Path $log -Value $message
    Write-Output $message
}
Set-Content -Path $log -Value ('started ' + (Get-Date).ToString('o') + ' as ' + ([Security.Principal.WindowsIdentity]::GetCurrent().Name))

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

$dataDevices = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
        $_.InstanceId -match 'VID_0E8D&PID_201C' -and $_.Status -eq 'OK'
    })
if (-not $dataDevices.Count) {
    Log 'USB data device is already gone, so the cable can charge.'
    Log 'done'
    exit 0
}

Log 'Removing USB data device so the phone can charge...'
foreach ($dev in $dataDevices) {
    Log ('  ' + $dev.FriendlyName + ' | ' + $dev.InstanceId)
    $removeOut = & pnputil.exe /remove-device $dev.InstanceId /force 2>&1 | Out-String
    Log $removeOut.Trim()
}
$still = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
        $_.InstanceId -match 'VID_0E8D&PID_201C' -and $_.Status -eq 'OK'
    })
if (-not $still.Count) {
    Log 'USB data device is already gone, so the cable can charge.'
}

Log 'USB devices now:'
Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_0E8D' } |
    ForEach-Object { Log ('  {0} | {1} | {2}' -f $_.Status, $_.FriendlyName, $_.InstanceId) }
Log 'done'
