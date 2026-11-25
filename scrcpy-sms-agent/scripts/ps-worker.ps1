# Long-lived helper for the agent. Starting PowerShell, compiling the capture
# type and loading the OCR engine costs several seconds; doing that for every
# screenshot and every OCR pass made codes reach the endpoint late. This keeps
# one session loaded and runs the other scripts in it on request.
#
# Protocol (one line each way):
#   in : {"id":1,"script":"ocr-code.ps1","params":{"ImagePath":"C:\\x.png","Analyze":true}}
#   out: @@R {"id":1,"ok":true,"out":"...","error":""}
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$allowed = @('capture-scrcpy.ps1', 'ocr-code.ps1')

[Console]::Out.WriteLine('@@READY')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break } # the agent went away
    $line = $line.Trim()
    if (-not $line) { continue }
    $response = [ordered]@{ id = 0; ok = $false; out = ''; error = '' }
    try {
        $request = $line | ConvertFrom-Json
        $response.id = $request.id
        if ($allowed -notcontains [string]$request.script) {
            throw ('script not allowed: ' + $request.script)
        }
        $params = @{}
        if ($request.params) {
            foreach ($property in $request.params.PSObject.Properties) {
                $params[$property.Name] = $property.Value
            }
        }
        $target = Join-Path $PSScriptRoot ([string]$request.script)
        $output = & $target @params
        $response.out = (@($output) | ForEach-Object { [string]$_ }) -join "`n"
        $response.ok = $true
    } catch {
        $response.error = [string]$_.Exception.Message
    }
    [Console]::Out.WriteLine('@@R ' + ($response | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}
