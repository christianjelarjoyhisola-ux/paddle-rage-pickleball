# Package the existing brand artwork at the sizes required by mobile launchers.
# Run from the repository root in Windows PowerShell.
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile((Join-Path $PWD 'paddleragelogo-transparent.png'))
try {
  foreach ($spec in @(@('apple-touch-icon.png',180,0.88),@('app-icon-192.png',192,0.88),@('app-icon-512.png',512,0.88),@('app-icon-maskable-512.png',512,0.56))) {
    $size=[int]$spec[1]
    $canvas=New-Object System.Drawing.Bitmap($size,$size)
    $graphics=[System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.Clear([System.Drawing.Color]::FromArgb(8,16,10))
      $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $scale=($size*[double]$spec[2])/[Math]::Max($source.Width,$source.Height)
      $w=[int][Math]::Round($source.Width*$scale)
      $h=[int][Math]::Round($source.Height*$scale)
      $graphics.DrawImage($source,[int](($size-$w)/2),[int](($size-$h)/2),$w,$h)
      $canvas.Save((Join-Path $PWD $spec[0]),[System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $canvas.Dispose() }
  }
} finally { $source.Dispose() }

