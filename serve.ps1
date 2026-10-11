<#
    Mini static file server for local play.
    Usage:  powershell -ExecutionPolicy Bypass -File serve.ps1
    Then open  http://localhost:8125/
    Stop with Ctrl+C.

    NOTE: this file is intentionally ASCII-only, so that Windows PowerShell 5.1
    (which reads .ps1 as ANSI unless a BOM is present) can parse it correctly.
#>
param(
    [int]$Port = 8125,
    [string]$Root = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
    '.webmanifest' = 'application/manifest+json'
}

function Send-Response($stream, [int]$status, [string]$statusText, [byte[]]$body, [string]$type) {
    $head = "HTTP/1.1 $status $statusText`r`n" +
            "Content-Type: $type`r`n" +
            "Content-Length: $($body.Length)`r`n" +
            "Cache-Control: no-store`r`n" +
            "Connection: close`r`n`r`n"
    $headBytes = [System.Text.Encoding]::UTF8.GetBytes($head)
    $stream.Write($headBytes, 0, $headBytes.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "TeleChess is running: http://localhost:$Port/" -ForegroundColor Green
Write-Host "Root: $Root"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            $requestLine = $reader.ReadLine()
            if (-not $requestLine) { $client.Close(); continue }

            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line -or $line -eq '') { break }
            }

            $parts = $requestLine -split ' '
            $urlPath = if ($parts.Count -ge 2) { $parts[1] } else { '/' }
            $urlPath = ($urlPath -split '\?')[0]
            $rel = [System.Uri]::UnescapeDataString($urlPath).TrimStart('/')
            if ($rel -eq '') { $rel = 'index.html' }

            $full = Join-Path $Root ($rel -replace '/', '\')
            if (-not $full.StartsWith($Root)) {
                Send-Response $stream 403 'Forbidden' ([System.Text.Encoding]::UTF8.GetBytes('forbidden')) 'text/plain; charset=utf-8'
                $client.Close(); continue
            }
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                Send-Response $stream 404 'Not Found' ([System.Text.Encoding]::UTF8.GetBytes('not found')) 'text/plain; charset=utf-8'
                $client.Close(); continue
            }

            $ext = [System.IO.Path]::GetExtension($full).ToLower()
            $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($full)
            Send-Response $stream 200 'OK' $bytes $type
        } catch {
            Write-Host "Error: $_" -ForegroundColor Red
        } finally {
            try { $client.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
}