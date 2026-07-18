param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class PaddleRageChromaKey
{
    private static double ChannelAlpha(byte observed, byte key)
    {
        if (observed < key && key > 0) return (key - observed) / (double)key;
        if (observed > key && key < 255) return (observed - key) / (double)(255 - key);
        return 0.0;
    }

    private static byte Clamp(double value)
    {
        return (byte)Math.Max(0, Math.Min(255, Math.Round(value)));
    }

    public static void Remove(string inputPath, string outputPath)
    {
        using (var source = new Bitmap(inputPath))
        using (var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.DrawImageUnscaled(source, 0, 0);

            // The generated source uses a magenta key. Use the ideal key color
            // rather than one noisy sampled pixel so small background variation
            // does not become false opacity.
            Color key = Color.FromArgb(255, 0, 255);
            var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            BitmapData data = bitmap.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int bytes = Math.Abs(data.Stride) * bitmap.Height;
            byte[] pixels = new byte[bytes];
            Marshal.Copy(data.Scan0, pixels, 0, bytes);

            for (int y = 0; y < bitmap.Height; y++)
            {
                int row = y * data.Stride;
                for (int x = 0; x < bitmap.Width; x++)
                {
                    int i = row + x * 4;
                    byte b = pixels[i];
                    byte g = pixels[i + 1];
                    byte r = pixels[i + 2];
                    byte originalAlpha = pixels[i + 3];

                    double alpha = Math.Max(ChannelAlpha(r, key.R),
                        Math.Max(ChannelAlpha(g, key.G), ChannelAlpha(b, key.B)));

                    alpha = Math.Max(0.0, Math.Min(1.0, (alpha - 0.14) / 0.84));
                    if (alpha < 0.05)
                    {
                        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
                        continue;
                    }

                    if (alpha < 0.995)
                    {
                        pixels[i + 2] = Clamp((r - (1.0 - alpha) * key.R) / alpha);
                        pixels[i + 1] = Clamp((g - (1.0 - alpha) * key.G) / alpha);
                        pixels[i] = Clamp((b - (1.0 - alpha) * key.B) / alpha);
                    }

                    pixels[i + 3] = Clamp(originalAlpha * alpha);
                }
            }

            Marshal.Copy(pixels, 0, data.Scan0, bytes);
            bitmap.UnlockBits(data);
            bitmap.Save(outputPath, ImageFormat.Png);
        }
    }
}
'@

$inputFull = (Resolve-Path -LiteralPath $InputPath).Path
$outputFull = [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath))
[PaddleRageChromaKey]::Remove($inputFull, $outputFull)
Write-Output $outputFull
