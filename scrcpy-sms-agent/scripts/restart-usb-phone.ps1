$log = "C:\Users\John\Documents\ws-scrcpy\scrcpy-sms-agent\scripts\enable-phone-charging.log"
function Log($m){ Add-Content $log $m; Write-Output $m }
Add-Content $log ("restart-attempt " + (Get-Date).ToString("o"))
Log "pnputil restart phone data"
Log ((& pnputil.exe /restart-device "USB\VID_0E8D&PID_201C\0123456789ABCDEF" 2>&1 | Out-String).Trim())
Log "pnputil restart usb2 hub"
Log ((& pnputil.exe /restart-device "USB\VID_174C&PID_2074\5&2CF64626&0&6" 2>&1 | Out-String).Trim())
Log "pnputil enum phone"
Log ((& pnputil.exe /enum-devices /instanceid "USB\VID_0E8D&PID_201C\0123456789ABCDEF" 2>&1 | Out-String).Trim())
