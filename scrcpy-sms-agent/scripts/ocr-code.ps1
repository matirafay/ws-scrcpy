param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$AccountHint = '',
    [switch]$CountTotp,
    [switch]$DumpLines,
    [switch]$ListHidden,
    [switch]$Analyze
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtTask, [Type]$ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

function Normalize([string]$value) {
    # Lowercase FIRST — [^a-z0-9] would strip uppercase "CM"/"CIS"/"CC" otherwise.
    $lower = ([string]$value).ToLowerInvariant()
    return [regex]::Replace($lower, '[^a-z0-9]', '')
}

function FirstTotp([string]$value) {
    $spaced = [regex]::Match([string]$value, '(?<!\d)(\d{3})\s*(\d{3})(?!\d)')
    if ($spaced.Success) {
        return $spaced.Groups[1].Value + $spaced.Groups[2].Value
    }
    $digits = -join ([regex]::Matches([string]$value, '\d') | ForEach-Object { $_.Value })
    $m = [regex]::Match($digits, '(\d{6})')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function HintUser([string]$hint) {
    if ($hint -match '^(cis|cc|cm)(.+)$' -and $Matches[2].Length -ge 4) {
        return $Matches[2]
    }
    return $hint
}

function AccountPrefix([string]$norm) {
    if (-not $norm) { return '' }
    if ($norm.StartsWith('cis')) { return 'cis' }
    if ($norm.StartsWith('cc')) { return 'cc' }
    if ($norm.StartsWith('cm')) { return 'cm' }
    return ''
}

function IsNoiseNorm([string]$norm) {
    if (-not $norm) { return $true }
    return [bool]($norm -match 'fortitoken|promax|android|settings|battery|firtlnet')
}

function IsTotpLine([string]$line) {
    $code = FirstTotp $line
    if (-not $code) { return $false }
    $norm = Normalize $line
    $letters = ([regex]::Matches($norm, '[a-z]')).Count
    return ($letters -le 2)
}

function IsDashLine([string]$line) {
    return [regex]::IsMatch([string]$line, '[-–—•·]{2,}')
}

function IsSlotNoise([string]$line) {
    $norm = Normalize $line
    if (IsNoiseNorm $norm) { return $true }
    if ($norm -match '^(a)?\d{1,3}$') { return $true }
    if ($norm -match 'cursor|rtlnet|wifi|percent') { return $true }
    return $false
}

function IsCodeLikeLine([string]$line) {
    if (IsTotpLine $line) { return $true }
    if (IsDashLine $line -or IsSlotNoise $line) { return $false }
    $norm = Normalize $line
    $digits = ([regex]::Matches($norm, '\d')).Count
    $letters = ([regex]::Matches($norm, '[a-z]')).Count
    return ($digits -ge 3 -and $norm.Length -ge 5 -and $norm.Length -le 8 -and $letters -ge 1)
}

function CollectAccountSlots([string[]]$lines) {
    $labels = @()
    $totps = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $norm = Normalize $lines[$i]
        if (IsTotpLine $lines[$i]) {
            $totps += @{ Index = $i; Code = (FirstTotp $lines[$i]) }
            continue
        }
        if (IsNoiseNorm $norm) { continue }
        $prefix = AccountPrefix $norm
        if ($prefix) {
            $labels += @{ Index = $i; Prefix = $prefix }
        }
    }
    return @{ Labels = $labels; Totps = $totps }
}

function SlotLooksHidden([string[]]$lines, [int]$start, [int]$end) {
    # Only treat a row as hidden when OCR actually saw dashes. Missing digits
    # are an OCR miss, not a hide — tapping the eye would conceal visible codes.
    $hasDash = $false
    $hasTotp = $false
    for ($i = $start + 1; $i -lt $end; $i++) {
        if (IsTotpLine $lines[$i]) { $hasTotp = $true }
        if (IsDashLine $lines[$i]) { $hasDash = $true }
    }
    if ($hasTotp) { return $false }
    return $hasDash
}

function IsAccountLabel([string]$line) {
    $norm = Normalize $line
    if (IsNoiseNorm $norm) { return $false }
    if (AccountPrefix $norm) { return $true }
    if (-not $norm -or $norm.Length -lt 4) { return $false }
    $letters = ([regex]::Matches($norm, '[a-z]')).Count
    $digits = ([regex]::Matches($norm, '\d')).Count
    return ($letters -ge 4 -and $digits -le 2 -and -not (FirstTotp $line))
}

function BuildPrefixCodeMap([string[]]$lines) {
    # Pair codes to CM / CIS / CC even when OCR garbles usernames
    # (CM-jjilani -> CM-ijiler) or drops the middle CIS label.
    $rows = CollectAccountSlots $lines
    $labels = @($rows.Labels)
    $totps = @($rows.Totps)
    $map = @{}
    $order = @('cm', 'cis', 'cc')
    for ($li = 0; $li -lt $labels.Count; $li++) {
        $lab = $labels[$li]
        $end = if (($li + 1) -lt $labels.Count) { $labels[$li + 1].Index } else { $lines.Count }
        $slot = @()
        foreach ($t in $totps) {
            if ($t.Index -gt $lab.Index -and $t.Index -lt $end) {
                $slot += $t
            }
        }
        if ($slot.Count -ge 1 -and -not $map.ContainsKey($lab.Prefix)) {
            $map[$lab.Prefix] = $slot[0].Code
        }
        # A dropped middle label (CM, <two codes>, CC) may put CIS's digits in this slot.
        # Never give leftover digits after the last label to some other account.
        if ($slot.Count -gt 1 -and ($li + 1) -lt $labels.Count) {
            $fromIdx = [array]::IndexOf($order, $lab.Prefix)
            $toIdx = [array]::IndexOf($order, $labels[$li + 1].Prefix)
            $extras = @($slot | Select-Object -Skip 1)
            $ei = 0
            if ($fromIdx -ge 0 -and $toIdx -gt ($fromIdx + 1)) {
                for ($p = $fromIdx + 1; $p -lt $toIdx -and $ei -lt $extras.Count; $p++) {
                    $missing = $order[$p]
                    if (-not $map.ContainsKey($missing)) {
                        $map[$missing] = $extras[$ei].Code
                        $ei++
                    }
                }
            }
        }
    }
    return $map
}

function BuildLabelCodeMap([string[]]$lines) {
    # Pair each OTP line with the nearest preceding account label.
    $labelIdx = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if (IsAccountLabel $lines[$i]) { $labelIdx += $i }
    }
    $map = @{}
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if (-not (IsTotpLine $lines[$i])) { continue }
        $code = FirstTotp $lines[$i]
        if (-not $code) { continue }
        $owner = -1
        foreach ($li in $labelIdx) {
            if ($li -lt $i) { $owner = $li } else { break }
        }
        if ($owner -ge 0 -and -not $map.ContainsKey($owner)) {
            $map[$owner] = $code
        }
    }
    foreach ($li in $labelIdx) {
        if (-not $map.ContainsKey($li)) {
            $same = FirstTotp $lines[$li]
            if ($same) { $map[$li] = $same }
        }
    }
    return $map
}

function LabelMatchesHint([string]$lineNorm, [string]$hint, [string]$user) {
    if (-not $lineNorm) { return $false }
    if ($lineNorm -eq $hint -or $lineNorm.Contains($hint) -or ($hint.Contains($lineNorm) -and $lineNorm.Length -ge 6)) {
        return $true
    }
    $hintPrefix = AccountPrefix $hint
    $linePrefix = AccountPrefix $lineNorm
    if ($hintPrefix -and $linePrefix -and $hintPrefix -eq $linePrefix) {
        return $true
    }
    if ($user.Length -ge 4 -and $lineNorm.Contains($user)) {
        return $true
    }
    return $false
}

function HiddenPrefixes([string[]]$lines) {
    $rows = CollectAccountSlots $lines
    $labels = @($rows.Labels)
    $hidden = @()
    for ($li = 0; $li -lt $labels.Count; $li++) {
        $lab = $labels[$li]
        $end = if (($li + 1) -lt $labels.Count) { $labels[$li + 1].Index } else { $lines.Count }
        if (SlotLooksHidden $lines $lab.Index $end) {
            $hidden += $lab.Prefix
        }
    }
    return @($hidden | Select-Object -Unique)
}

function DumpLinesText([string[]]$lines) {
    $i = 0
    $parts = @()
    foreach ($line in $lines) {
        $safe = [regex]::Replace([string]$line, '\d', '#')
        $safe = [regex]::Replace($safe, '[\u0000-\u001F]', ' ')
        $norm = Normalize $line
        $parts += "L$i norm=$norm safe=$safe"
        $i++
    }
    return ($parts -join ' || ')
}

function ResolveHint([string[]]$lines, [string]$AccountHint) {
    $hint = Normalize $AccountHint
    if (-not $hint) { return '' }
    $user = HintUser $hint
    $prefix = AccountPrefix $hint
    $prefixMap = BuildPrefixCodeMap $lines
    if ($prefix -and $prefixMap.ContainsKey($prefix) -and $prefixMap[$prefix]) {
        return [string]$prefixMap[$prefix]
    }
    $map = BuildLabelCodeMap $lines
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $lineNorm = Normalize $lines[$i]
        if (-not (LabelMatchesHint $lineNorm $hint $user)) { continue }
        if ($map.ContainsKey($i) -and $map[$i]) {
            return [string]$map[$i]
        }
        if (($i + 1) -lt $lines.Count -and -not (IsAccountLabel $lines[$i + 1])) {
            $n = FirstTotp $lines[$i + 1]
            if ($n) { return $n }
        }
    }
    return ''
}

function TotpCount([string[]]$lines) {
    $codes = New-Object System.Collections.Generic.HashSet[string]
    foreach ($line in $lines) {
        if (-not (IsTotpLine $line)) { continue }
        $code = FirstTotp $line
        if ($code) { [void]$codes.Add($code) }
    }
    return $codes.Count
}

function AnalyzeText([string[]]$lines) {
    $payload = [ordered]@{
        totp = TotpCount $lines
        codes = [ordered]@{
            cm = (ResolveHint $lines 'CM-jjilani')
            cis = (ResolveHint $lines 'CIS-mmehmood')
            cc = (ResolveHint $lines 'CC-tmalik')
        }
        hidden = @(HiddenPrefixes $lines)
        dump = if ($lines -and $lines.Count) { DumpLinesText $lines } else { 'EMPTY_OCR' }
    }
    return ($payload | ConvertTo-Json -Compress -Depth 4)
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
}
if (-not $engine) {
    if ($CountTotp) { Write-Output '0' }
    elseif ($Analyze) { Write-Output '{"totp":0,"codes":{"cm":"","cis":"","cc":""},"hidden":[],"dump":""}' }
    else { Write-Output '' }
    exit 0
}

function RecognizePng([string]$pngPath) {
    $resolved = (Resolve-Path -LiteralPath $pngPath).Path
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
                $bitmap,
                [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
            )
        } catch {
            # Some PNG frames are already Bgra8; keep the decoded bitmap.
        }
        return Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    } finally {
        $stream.Dispose()
    }
}

function Save-Inverted([string]$src, [string]$dest) {
    $bmp = [System.Drawing.Bitmap]::FromFile($src)
    $out = New-Object System.Drawing.Bitmap $bmp.Width, $bmp.Height
    $g = [System.Drawing.Graphics]::FromImage($out)
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $cm = New-Object System.Drawing.Imaging.ColorMatrix (,([float[][]]@(
        [float[]]@(-1, 0, 0, 0, 0),
        [float[]]@(0, -1, 0, 0, 0),
        [float[]]@(0, 0, -1, 0, 0),
        [float[]]@(0, 0, 0, 1, 0),
        [float[]]@(1, 1, 1, 0, 1)
    )))
    try {
        $ia.SetColorMatrix($cm)
        $rect = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
        $g.DrawImage($bmp, $rect, 0, 0, $bmp.Width, $bmp.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
        if (Test-Path -LiteralPath $dest) {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
        }
        $out.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $ia.Dispose()
        $g.Dispose()
        $out.Dispose()
        $bmp.Dispose()
    }
}

$path = (Resolve-Path -LiteralPath $ImagePath).Path
$lines = @()
try {
    $result = RecognizePng $path
    $lines = @($result.Lines | ForEach-Object { $_.Text })
} catch {
    $lines = @()
}
# Dark FortiToken UI (light digits on black) often OCR as empty until inverted.
if (-not $lines -or $lines.Count -eq 0) {
    $inv = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('scrcpy-sms-ocr-inv-{0}.png' -f $PID))
    try {
        Save-Inverted $path $inv
        $result = RecognizePng $inv
        $lines = @($result.Lines | ForEach-Object { $_.Text })
    } catch {
        # Keep the original empty result.
    } finally {
        Remove-Item -LiteralPath $inv -Force -ErrorAction SilentlyContinue
    }
}

if ($Analyze) {
    Write-Output (AnalyzeText $lines)
    exit 0
}

if ($DumpLines) {
    Write-Output (DumpLinesText $lines).Replace(' || ', [Environment]::NewLine)
    exit 0
}

if ($CountTotp) {
    Write-Output (TotpCount $lines)
    exit 0
}

if ($ListHidden) {
    Write-Output ((HiddenPrefixes $lines) -join ',')
    exit 0
}

$hint = Normalize $AccountHint
if ($hint) {
    Write-Output (ResolveHint $lines $AccountHint)
    exit 0
}

$all = FirstTotp (($lines) -join ' ')
Write-Output $all
