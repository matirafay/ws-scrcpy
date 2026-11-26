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
    if ([regex]::IsMatch([string]$line, '[-–—•·●○◉▪■\.]{2,}')) { return $true }
    if ([regex]::IsMatch([string]$line, '(?i)hidden')) { return $true }
    $norm = Normalize $line
    # 6.6 often OCRs each hidden row as a single hollow circle / O.
    if ($norm -match '^(o|x|0){1,}$') { return $true }
    return $false
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
    # 6.6 draws dashes as circles after the names, not between labels.
    $anyDash = $false
    foreach ($line in $lines) {
        if (IsDashLine $line) { $anyDash = $true; break }
    }
    if ($anyDash -and @($rows.Totps).Count -eq 0) {
        foreach ($lab in $labels) { $hidden += $lab.Prefix }
    } elseif ($anyDash) {
        # Partial hide: a label with no digits in its slot is dashed.
        for ($li = 0; $li -lt $labels.Count; $li++) {
            $lab = $labels[$li]
            $end = if (($li + 1) -lt $labels.Count) { $labels[$li + 1].Index } else { $lines.Count }
            $hasTotp = $false
            foreach ($t in @($rows.Totps)) {
                if ($t.Index -gt $lab.Index -and $t.Index -lt $end) { $hasTotp = $true; break }
            }
            if (-not $hasTotp) { $hidden += $lab.Prefix }
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
        $tall = if ($i -lt $script:lineHeights.Count) { $script:lineHeights[$i] } else { 0 }
        $parts += "L$i h=$tall norm=$norm safe=$safe"
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

function LabelCodePairs([string[]]$lines) {
    # Every "account label -> code under it" pair, so accounts outside
    # CM / CIS / CC are resolved in this same pass instead of a second OCR run.
    # Stricter than the prefix map: the code line must hold exactly six digits
    # and be clearly taller than its label. The dashes of a hidden code and the
    # small status-bar numbers are sometimes read as digits; both are short.
    $heights = @($script:lineHeights)
    $haveHeights = ($heights.Count -eq $lines.Count)
    $pairs = @()
    $owner = -1
    $ownerUsed = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $text = [string]$lines[$i]
        # Zeros are sometimes read as the letter O ("169 ooo" for 169 000). Only
        # a line shaped exactly like a code (3 + 3 of digits and O's, with at
        # least one real digit) is repaired, and it still has to pass the
        # height check below.
        $shapedLikeCode = ($text -match '^\s*[0-9Oo]{3}\s*[0-9Oo]{3}\s*$') -and ($text -match '\d')
        if ($shapedLikeCode) { $text = ($text -replace '[Oo]', '0') }
        if (-not $shapedLikeCode -and (IsAccountLabel $lines[$i])) {
            $owner = $i
            $ownerUsed = $false
            continue
        }
        if ($owner -lt 0 -or $ownerUsed -or -not (IsTotpLine $text)) { continue }
        if (([regex]::Matches($text, '\d')).Count -ne 6) { continue }
        if ($haveHeights -and $heights[$owner] -gt 0 -and $heights[$i] -lt (1.5 * $heights[$owner])) { continue }
        $code = FirstTotp $text
        if (-not $code) { continue }
        $pairs += [ordered]@{ label = (Normalize $lines[$owner]); code = [string]$code; index = $owner }
        $ownerUsed = $true
    }
    return $pairs
}

function CodeShaped([string]$text) {
    # "123 456", allowing zeros read as the letter O. '' when it is not a code.
    if (-not (($text -match '^\s*[0-9Oo]{3}\s*[0-9Oo]{3}\s*$') -and ($text -match '\d'))) { return '' }
    return (($text -replace '[Oo]', '0') -replace '\s', '')
}

# Windows OCR sometimes drops half or all of a code that is plainly on screen
# (seen with codes containing 4s: only "397" read of "397 484"). The same row
# read at another size usually comes out whole, but a single re-read can also
# misread a digit (5 as 6). So the row is read at several sizes and a code
# counts only when two of those reads agree and none of them disagrees.
# "Row" reads just the strip under the label; the others read the whole picture.
# Ordered by how often each one recovered a dropped code in testing.
$script:rescueVariants = @(
    @{ Name = 'row0.6'; Row = $true; Scale = 0.6 },
    @{ Name = 'full0.75'; Row = $false; Scale = 0.75 },
    @{ Name = 'row0.5'; Row = $true; Scale = 0.5 },
    @{ Name = 'full1.25'; Row = $false; Scale = 1.25 },
    @{ Name = 'full0.6'; Row = $false; Scale = 0.6 },
    @{ Name = 'full1.5'; Row = $false; Scale = 1.5 },
    @{ Name = 'row2'; Row = $true; Scale = 2.0 }
)
$script:rescueCache = @{}
$script:rescueBitmap = $null
$script:rescueTries = 0
$MAX_RESCUE_LABELS = 6

function ReadRegion([double]$x, [double]$y, [double]$w, [double]$h, [double]$scale, [int]$pad) {
    # OCR one region of the picture drawn at another size on a white margin.
    # Line boxes come back in the original picture's pixels.
    $src = $script:rescueBitmap
    $dw = [int][Math]::Max(1, [Math]::Round($w * $scale))
    $dh = [int][Math]::Max(1, [Math]::Round($h * $scale))
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('scrcpy-sms-ocr-row-{0}.png' -f $PID))
    $out = New-Object System.Drawing.Bitmap ($dw + 2 * $pad), ($dh + 2 * $pad)
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.Clear([System.Drawing.Color]::White)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $dest = New-Object System.Drawing.Rectangle $pad, $pad, $dw, $dh
        $g.DrawImage($src, $dest, [float]$x, [float]$y, [float]$w, [float]$h, [System.Drawing.GraphicsUnit]::Pixel)
        $out.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $g.Dispose()
        $out.Dispose()
    }
    $found = @()
    try {
        $result = RecognizePng $tmp
        $script:rescueTries++
        foreach ($line in $result.Lines) {
            $top = [double]::MaxValue; $bottom = 0.0; $left = [double]::MaxValue; $tall = 0.0
            foreach ($word in $line.Words) {
                $box = $word.BoundingRect
                if ($box.Y -lt $top) { $top = $box.Y }
                if (($box.Y + $box.Height) -gt $bottom) { $bottom = $box.Y + $box.Height }
                if ($box.X -lt $left) { $left = $box.X }
                if ($box.Height -gt $tall) { $tall = $box.Height }
            }
            $found += @{
                Text = [string]$line.Text
                Mid = $y + ((($top + $bottom) / 2) - $pad) / $scale
                Left = $x + ($left - $pad) / $scale
                Tall = $tall / $scale
            }
        }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    return $found
}

function RescueCode([string[]]$lines, [int]$index) {
    $box = $script:lineRects[$index]
    $labelTall = [double]$script:lineHeights[$index]
    if (-not $box -or $labelTall -lt 6) { return '' }
    if (-not $script:rescueBitmap) {
        $script:rescueBitmap = [System.Drawing.Bitmap]::FromFile($script:rescueSource)
    }
    $imageW = $script:rescueBitmap.Width
    $imageH = $script:rescueBitmap.Height
    # The code sits just under its label, starting at about the same left edge.
    $bandTop = $box.Bottom
    $bandBottom = $box.Bottom + 4.5 * $labelTall
    # Half a code the first pass did read must be part of the answer.
    $halves = @()
    for ($j = 0; $j -lt $lines.Count; $j++) {
        if ($j -eq $index -or -not $script:lineRects[$j]) { continue }
        $mid = ($script:lineRects[$j].Top + $script:lineRects[$j].Bottom) / 2
        if ($mid -lt $bandTop -or $mid -gt $bandBottom) { continue }
        if ($script:lineHeights[$j] -lt (1.5 * $labelTall)) { continue }
        if ([string]$lines[$j] -match '^\s*(\d{3})\s*$') { $halves += $Matches[1] }
    }
    $votes = @{}
    $read = 0
    foreach ($variant in $script:rescueVariants) {
        if ($variant.Row) {
            $x = [Math]::Max(0, $box.Left - 1.2 * $labelTall)
            $y = [Math]::Min($imageH - 1, $box.Bottom + 0.35 * $labelTall)
            $w = [Math]::Min(21.4 * $labelTall, $imageW - $x)
            $h = [Math]::Min(4.15 * $labelTall, $imageH - $y)
            $found = @(ReadRegion $x $y $w $h $variant.Scale 24)
        } else {
            if (-not $script:rescueCache.ContainsKey($variant.Name)) {
                $script:rescueCache[$variant.Name] = @(ReadRegion 0 0 $imageW $imageH $variant.Scale 0)
            }
            $found = @($script:rescueCache[$variant.Name])
        }
        $read++
        foreach ($line in $found) {
            $code = CodeShaped $line.Text
            if (-not $code) { continue }
            if ($line.Mid -lt $bandTop -or $line.Mid -gt $bandBottom) { continue }
            if ($line.Tall -lt (1.5 * $labelTall)) { continue }
            if ($line.Left -gt ($box.Left + 4 * $labelTall)) { continue }
            $fits = ($halves.Count -eq 0)
            foreach ($half in $halves) {
                if ($code.StartsWith($half) -or $code.EndsWith($half)) { $fits = $true }
            }
            if (-not $fits) { continue }
            $votes[$code] = 1 + [int]$votes[$code]
            break
        }
        # Two different answers: one read is wrong and there is no telling which.
        if ($votes.Count -gt 1) { return '' }
        foreach ($code in @($votes.Keys)) {
            if ($votes[$code] -ge 2) { return $code }
        }
        # Five reads with no code at all: the row is hidden or is not a code row.
        if ($read -ge 5 -and $votes.Count -eq 0) { break }
    }
    return ''
}

function RescueMissingCodes([string[]]$lines, $pairs) {
    # Labels that got no code in the first pass. Known account prefixes first.
    $rescued = @()
    if (-not $script:rescueSource -or $script:lineRects.Count -ne $lines.Count) { return $rescued }
    $have = @{}
    foreach ($pair in $pairs) { $have[[int]$pair.index] = $true }
    $wanted = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($have.ContainsKey($i) -or (CodeShaped $lines[$i]) -or -not (IsAccountLabel $lines[$i])) { continue }
        $wanted += $i
    }
    $wanted = @($wanted | Sort-Object { if (AccountPrefix (Normalize $lines[$_])) { 0 } else { 1 } }, { $_ } | Select-Object -First $MAX_RESCUE_LABELS)
    try {
        foreach ($i in $wanted) {
            $code = ''
            try { $code = RescueCode $lines $i } catch { $code = '' }
            if ($code) {
                $rescued += [ordered]@{ label = (Normalize $lines[$i]); code = [string]$code; index = $i }
            }
        }
    } finally {
        if ($script:rescueBitmap) {
            $script:rescueBitmap.Dispose()
            $script:rescueBitmap = $null
        }
    }
    return $rescued
}

function AnalyzeText([string[]]$lines) {
    $codes = [ordered]@{
        cm = (ResolveHint $lines 'CM-jjilani')
        cis = (ResolveHint $lines 'CIS-mmehmood')
        cc = (ResolveHint $lines 'CC-tmalik')
    }
    $hidden = @(HiddenPrefixes $lines)
    $pairs = @(LabelCodePairs $lines)
    $totp = TotpCount $lines
    $rescued = @(RescueMissingCodes $lines $pairs)
    $rescuedNames = @()
    foreach ($pair in $rescued) {
        $pairs += $pair
        $rescuedNames += [string]$pair.label
        $totp++
        $prefix = AccountPrefix ([string]$pair.label)
        if ($prefix -and -not $codes[$prefix]) {
            $codes[$prefix] = [string]$pair.code
            $hidden = @($hidden | Where-Object { $_ -ne $prefix })
        }
    }
    $payload = [ordered]@{
        totp = $totp
        codes = $codes
        hidden = @($hidden)
        labels = @($pairs)
        rescued = @($rescuedNames)
        reads = $script:rescueTries
        dump =if ($lines -and $lines.Count) { DumpLinesText $lines } else { 'EMPTY_OCR' }
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

function LineHeights($ocrResult) {
    # Tallest word box per OCR line, in pixels. Digits are tall; the dashes of a
    # hidden code are thin bars that OCR sometimes turns into digits.
    return @($ocrResult.Lines | ForEach-Object {
            $max = 0
            foreach ($word in $_.Words) {
                $h = [double]$word.BoundingRect.Height
                if ($h -gt $max) { $max = $h }
            }
            [int][Math]::Round($max)
        })
}

function LineRects($ocrResult) {
    # Box around each OCR line (all of its words), in picture pixels.
    return @($ocrResult.Lines | ForEach-Object {
            $left = [double]::MaxValue; $top = [double]::MaxValue; $right = 0.0; $bottom = 0.0
            foreach ($word in $_.Words) {
                $box = $word.BoundingRect
                if ($box.X -lt $left) { $left = $box.X }
                if ($box.Y -lt $top) { $top = $box.Y }
                if (($box.X + $box.Width) -gt $right) { $right = $box.X + $box.Width }
                if (($box.Y + $box.Height) -gt $bottom) { $bottom = $box.Y + $box.Height }
            }
            [pscustomobject]@{ Left = $left; Top = $top; Right = $right; Bottom = $bottom }
        })
}

$path = (Resolve-Path -LiteralPath $ImagePath).Path
$lines = @()
$script:lineHeights = @()
$script:lineRects = @()
# Picture the line boxes refer to; empty when the inverted copy was read instead.
$script:rescueSource = ''
try {
    $result = RecognizePng $path
    $lines = @($result.Lines | ForEach-Object { $_.Text })
    $script:lineHeights = @(LineHeights $result)
    $script:lineRects = @(LineRects $result)
    $script:rescueSource = $path
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
        $script:lineHeights = @(LineHeights $result)
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
