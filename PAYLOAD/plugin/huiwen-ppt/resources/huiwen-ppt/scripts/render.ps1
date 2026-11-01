param(
    [Parameter(Mandatory=$true)][string]$Source,
    [Parameter(Mandatory=$true)][string]$Output,
    [ValidateSet('wps','powerpoint')][string]$Engine = 'wps'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$outputPath = [System.IO.Path]::GetFullPath($Output)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
$app = $null
$deck = $null
$progID = if ($Engine -eq 'wps') { 'KWPP.Application' } else { 'PowerPoint.Application' }
try {
    $app = New-Object -ComObject $progID
    # Read-only and without a document window. Close only the deck opened here.
    $deck = $app.Presentations.Open($sourcePath, -1, 0, 0)
    $count = $deck.Slides.Count
    $slideWidth = [double]$deck.PageSetup.SlideWidth
    $slideHeight = [double]$deck.PageSetup.SlideHeight
    $pixelWidth = 1440
    $pixelHeight = [int][Math]::Round($pixelWidth * $slideHeight / $slideWidth)
    for ($i = 1; $i -le $count; $i++) {
        $file = Join-Path $outputPath ('slide-{0:D3}.png' -f $i)
        $slide = $deck.Slides.Item($i)
        try {
            $slide.Export($file, 'PNG', $pixelWidth, $pixelHeight)
            if (-not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) {
                throw "The native app did not export page $i"
            }
        } finally {
            [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($slide) | Out-Null
        }
    }
    $report = @{
        engine = $Engine
        prog_id = $progID
        version = [string]$app.Version
        slide_count = $count
        width = $pixelWidth
        height = $pixelHeight
        rendering = 'native_application'
        editability_review = 'pending'
    } | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $outputPath 'native-render.json'), $report, [System.Text.UTF8Encoding]::new($false))
    Write-Output $report
} finally {
    if ($null -ne $deck) {
        $deck.Close()
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck) | Out-Null
    }
    if ($null -ne $app) {
        # The COM app may share a running user session; do not quit that session.
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) | Out-Null
    }
}
