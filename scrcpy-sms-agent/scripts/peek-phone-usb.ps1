$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Get-PnpDevice -PresentOnly |
    Where-Object {
        $_.InstanceId -match 'VID_0E8D|VID_18D1|VID_04E8|VID_22D9|VID_2A70|VID_0BB4|VID_2717' -or
        $_.FriendlyName -match 'Android|ADB Interface|I15|MTP|MediaTek'
    } |
    ForEach-Object { '{0}|{1}|{2}' -f $_.InstanceId, $_.Class, $_.FriendlyName }
