// Build-time helper: compresses the packed application with LZMS.
//
//   Pack.exe <input> <output>
//
// LZMS lives in Windows' own Compression API (cabinet.dll), which is why the
// launcher can decompress it without carrying a compression library. .NET has
// no managed API for it and Node has none at all, so this small tool does the
// compression side during the build. It exists only on the developer machine.
//
// On this payload LZMS reaches 90 MB where Deflate — all .NET Framework offers
// natively — manages 104 MB, which is the whole reason for going through
// Windows rather than using DeflateStream.
//
// TWO THINGS THAT LOOK LIKE IMPROVEMENTS AND ARE NOT. Asking Windows for the
// exact output size before allocating — by passing a null output buffer —
// compresses the whole payload internally just to measure it, so the real call
// then does the work twice; that alone took this step from about ninety seconds
// to twenty minutes. And comparing the round trip byte by byte over 240 million
// elements is far slower than hashing both sides, which is hardware-accelerated.
// The input is released before the verification buffer is allocated, so the
// peak stays near 480 MB rather than 810 MB.
//
// Written to C# 5, because the compiler is csc.exe from the in-box .NET
// Framework and there is deliberately no SDK involved.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

internal static class Pack
{
    private const uint CompressAlgorithmLzms = 5;

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool CreateCompressor(uint algorithm, IntPtr allocRoutines, out IntPtr handle);

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool Compress(
        IntPtr handle, byte[] input, IntPtr inputSize, byte[] output, IntPtr outputSize, out IntPtr used);

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool CloseCompressor(IntPtr handle);

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool CreateDecompressor(uint algorithm, IntPtr allocRoutines, out IntPtr handle);

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool Decompress(
        IntPtr handle, byte[] input, IntPtr inputSize, byte[] output, IntPtr outputSize, out IntPtr used);

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool CloseDecompressor(IntPtr handle);

    private static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("usage: Pack.exe <input> <output>");
            return 2;
        }

        var overall = Stopwatch.StartNew();

        var raw = File.ReadAllBytes(args[0]);
        long rawLength = raw.Length;
        byte[] expectedHash = Sha256(raw);

        byte[] compressed;
        long used;
        var compressWatch = Stopwatch.StartNew();
        try
        {
            compressed = Compressed(raw, out used);
        }
        catch (Exception err)
        {
            Console.Error.WriteLine(err.Message);
            return 1;
        }
        compressWatch.Stop();

        // Let the 240 MB input go before the verification buffer is allocated,
        // so the two are never resident at the same time.
        raw = null;
        GC.Collect();
        GC.WaitForPendingFinalizers();

        var verifyWatch = Stopwatch.StartNew();
        byte[] roundTripped;
        try
        {
            // Only the first `used` bytes of the buffer are the payload; the
            // rest is slack, and Decompress is told to ignore it.
            roundTripped = Decompressed(compressed, used, (int)rawLength);
        }
        catch (Exception err)
        {
            Console.Error.WriteLine(err.Message);
            return 1;
        }

        // Compare by hash rather than element by element: same guarantee, and
        // SHA-256 is hardware-accelerated where a managed loop over 240 million
        // bytes is not.
        bool identical = Same(expectedHash, Sha256(roundTripped));
        roundTripped = null;
        verifyWatch.Stop();

        if (!identical)
        {
            Console.Error.WriteLine("The compressed payload did not decompress back to the original.");
            return 1;
        }

        using (var fs = new FileStream(args[1], FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(compressed, 0, (int)used);
        }

        Console.WriteLine(
            "  LZMS " + Mb(rawLength) + " -> " + Mb(used)
            + " (" + (100 - (used * 100L / rawLength)) + "% smaller)");
        Console.WriteLine(
            "  compressed in " + Secs(compressWatch) + ", verified by round trip in " + Secs(verifyWatch)
            + " (" + Secs(overall) + " total)");
        return 0;
    }

    /// <summary>
    /// Compress into a buffer the size of the input, reporting how much of it
    /// was used.
    ///
    /// The tidier-looking approach is to ask Windows for the exact output size
    /// first, by passing a null output buffer, and allocate only that. Do not:
    /// that query compresses the whole payload internally just to measure it,
    /// and the real call then compresses it all over again. It took this step
    /// from about ninety seconds to twenty minutes. LZMS never expands
    /// incompressible input by more than a fraction, so the input length is a
    /// safe ceiling and one pass is enough.
    /// </summary>
    private static byte[] Compressed(byte[] raw, out long used)
    {
        IntPtr handle;
        if (!CreateCompressor(CompressAlgorithmLzms, IntPtr.Zero, out handle))
        {
            throw new InvalidOperationException("CreateCompressor failed: " + Marshal.GetLastWin32Error());
        }

        try
        {
            var buffer = new byte[raw.Length];
            IntPtr usedBytes;
            if (!Compress(handle, raw, (IntPtr)raw.Length, buffer, (IntPtr)buffer.Length, out usedBytes))
            {
                throw new InvalidOperationException("Compress failed: " + Marshal.GetLastWin32Error());
            }
            used = (long)usedBytes;
            return buffer;
        }
        finally
        {
            CloseCompressor(handle);
        }
    }

    private static byte[] Decompressed(byte[] compressed, long compressedLength, int rawLength)
    {
        IntPtr handle;
        if (!CreateDecompressor(CompressAlgorithmLzms, IntPtr.Zero, out handle))
        {
            throw new InvalidOperationException("CreateDecompressor failed: " + Marshal.GetLastWin32Error());
        }

        try
        {
            var back = new byte[rawLength];
            IntPtr used;
            if (!Decompress(handle, compressed, (IntPtr)compressedLength, back, (IntPtr)back.Length, out used))
            {
                throw new InvalidOperationException("Decompress failed: " + Marshal.GetLastWin32Error());
            }
            if ((long)used != rawLength)
            {
                throw new InvalidOperationException("Decompress produced " + (long)used + " bytes, expected " + rawLength);
            }
            return back;
        }
        finally
        {
            CloseDecompressor(handle);
        }
    }

    private static byte[] Sha256(byte[] data)
    {
        using (var sha = SHA256.Create()) return sha.ComputeHash(data);
    }

    private static bool Same(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    private static string Mb(long bytes)
    {
        return ((double)bytes / 1048576.0).ToString("F1") + " MB";
    }

    private static string Secs(Stopwatch w)
    {
        return (w.ElapsedMilliseconds / 1000.0).ToString("F0") + "s";
    }
}
