param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$Padding = 28,
  [int]$AlphaThreshold = 8
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;

public static class PaddleRageTransparentCrop
{
    public static void Crop(string inputPath, string outputPath, int padding, int alphaThreshold)
    {
        using (var source = new Bitmap(inputPath))
        {
            int left = source.Width;
            int top = source.Height;
            int right = -1;
            int bottom = -1;

            for (int y = 0; y < source.Height; y++)
            {
                for (int x = 0; x < source.Width; x++)
                {
                    if (source.GetPixel(x, y).A <= alphaThreshold) continue;
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                }
            }

            if (right < left || bottom < top)
                throw new InvalidOperationException("No visible pixels were found.");

            left = Math.Max(0, left - padding);
            top = Math.Max(0, top - padding);
            right = Math.Min(source.Width - 1, right + padding);
            bottom = Math.Min(source.Height - 1, bottom + padding);

            int width = right - left + 1;
            int height = bottom - top + 1;
            using (var output = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(output))
            {
                graphics.Clear(Color.Transparent);
                graphics.DrawImage(source, new Rectangle(0, 0, width, height),
                    new Rectangle(left, top, width, height), GraphicsUnit.Pixel);
                output.Save(outputPath, ImageFormat.Png);
            }
        }
    }
}
'@

$inputFull = (Resolve-Path -LiteralPath $InputPath).Path
$outputFull = [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath))
[PaddleRageTransparentCrop]::Crop($inputFull, $outputFull, $Padding, $AlphaThreshold)
Write-Output $outputFull
