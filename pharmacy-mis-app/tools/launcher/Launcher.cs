// Pharmacy-MIS.exe — the single-file launcher.
//
// This is the whole of what the customer receives. The complete Electron
// application is compressed and appended to the end of this executable. On
// first run the launcher unpacks it into the user's own profile and starts it;
// every run after that finds the unpacked copy already there and starts it
// straight away.
//
// WHY THIS IS C# AND ABOUT 20 KB
// ------------------------------
// The first working version of this launcher was a Node single executable.
// It did the same job, but a copy of node.exe is 91 MB — half the size of the
// whole release — spent on a runtime whose only work is to decompress and
// spawn. Rewriting it against components Windows already has takes the release
// from 176 MB to about 91 MB.
//
// It relies on two in-box Windows components:
//   .NET Framework 4.x   present and non-removable on Windows 10 1903+ and 11
//   cabinet.dll          the Compression API, present since Windows 8
// Neither is something the customer installs. LZMS, from that API, compresses
// this payload to 90 MB where Deflate — the only thing .NET Framework offers
// natively — manages 104 MB.
//
// WHY NOT electron-builder's "portable" TARGET
// --------------------------------------------
// That is the obvious way to get one exe and it was tried first. Its NSIS stub
// exits with code 1 on this machine without unpacking anything, printing
// nothing and logging nothing — an opaque third-party failure of exactly the
// kind that becomes "it doesn't work on the customer's PC" with no way to
// diagnose it. Everything here is ours instead: every step is checked, every
// failure is shown to the user in words and written to the log.
//
// WHAT IT GUARANTEES
//   - nothing is read from beside the exe: the payload is inside it
//   - nothing is written beside the exe, so the exe may live in Program Files,
//     on a read-only share or on a USB stick
//   - the exe may be renamed and started from any working directory
//   - the unpack is keyed by version and payload hash, so a new build replaces
//     the old one and a half-finished unpack is never used
//   - arguments and the exit code pass straight through, so --cli and
//     --self-test behave exactly as they do in the application itself

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Launcher
{
    private const string AppName = "Pharmacy MIS";
    private const string AppDirName = "PharmacyMIS";
    private const string InnerExe = "Pharmacy MIS.exe";

    // The copy of any failure that the customer can actually find.
    private const string DocsFolderName = "Pharmacy MIS";
    private const string ErrorLogName = "Pharmacy MIS - Error Log.txt";
    private const long ErrorLogMaxBytes = 1024 * 1024;

    // Written at the very end of the exe by tools/build.js, so the launcher can
    // find its own payload without knowing anything about PE layout.
    //
    // The bytes are "PHMISPL1"; read little-endian that is the value below.
    // No digit separators: the compiler used for this file is csc.exe from the
    // in-box .NET Framework, which is a C# 5 compiler. Everything here has to
    // stay within C# 5, because the whole point of using it is that it is
    // already on the machine and needs no SDK installed.
    private const ulong TrailerMagic = 0x314C5053494D4850UL;
    private const int TrailerBytes = 24;

    /* ---------------------------------------------------------------- *
     * Windows Compression API (cabinet.dll) — in-box since Windows 8
     * ---------------------------------------------------------------- */

    private const uint CompressAlgorithmLzms = 5;

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool CreateDecompressor(uint algorithm, IntPtr allocRoutines, out IntPtr handle);

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool Decompress(
        IntPtr handle, byte[] input, IntPtr inputSize, byte[] output, IntPtr outputSize, out IntPtr used);

    [DllImport("cabinet.dll", SetLastError = true)]
    private static extern bool CloseDecompressor(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

    private const uint MbIconError = 0x00000010;

    /* ---------------------------------------------------------------- *
     * Somewhere to write
     * ---------------------------------------------------------------- */

    private static string cachedBase;

    /// <summary>
    /// The folder the application owns, under the user's own profile. Never
    /// beside the exe: that may be somewhere the customer cannot write.
    /// LOCALAPPDATA is on every Windows install but is read from the
    /// environment, which a stripped service account can lack, so there are
    /// fallbacks behind it.
    /// </summary>
    private static string BaseDir()
    {
        if (cachedBase != null) return cachedBase;

        var candidates = new List<string>
        {
            Environment.GetEnvironmentVariable("LOCALAPPDATA"),
            Environment.GetEnvironmentVariable("APPDATA"),
            SafeCombine(Environment.GetEnvironmentVariable("USERPROFILE"), @"AppData\Local"),
            Path.GetTempPath(),
        };

        foreach (var root in candidates)
        {
            if (string.IsNullOrEmpty(root)) continue;
            try
            {
                var dir = Path.Combine(root, AppDirName);
                Directory.CreateDirectory(dir);
                cachedBase = dir;
                return dir;
            }
            catch
            {
                // try the next candidate
            }
        }

        throw new IOException(
            "No writable folder could be found for the application. " +
            "%LOCALAPPDATA% and the Windows temp folder are both unavailable.");
    }

    private static string SafeCombine(string a, string b)
    {
        if (string.IsNullOrEmpty(a)) return null;
        try { return Path.Combine(a, b); } catch { return null; }
    }

    private static string LogDir()
    {
        var dir = Path.Combine(BaseDir(), "logs");
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>
    /// The customer-facing error log, in Documents.
    ///
    /// %LOCALAPPDATA% is the right place for an application's logs and the
    /// wrong place to send a pharmacy user looking: it is hidden, the path is
    /// long, and "AppData" means nothing to them. So a failure is written a
    /// second time somewhere they can find it, read it and attach it to an
    /// email. The folder is created on the first failure and never before.
    ///
    /// Documents is resolved through Windows rather than assumed to be under
    /// the profile, because it is often redirected to OneDrive or a network
    /// share and the file has to land where they will actually look.
    /// </summary>
    private static string ErrorLogFile()
    {
        string docs = null;
        try { docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments); }
        catch { }

        if (string.IsNullOrEmpty(docs))
        {
            var profile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrEmpty(profile)) return null;
            docs = Path.Combine(profile, "Documents");
        }

        return Path.Combine(docs, DocsFolderName, ErrorLogName);
    }

    /// <summary>
    /// Mirror a failure into Documents. Best-effort and silent: this runs when
    /// something has already gone wrong, and must not add a second problem.
    /// </summary>
    private static string WriteErrorLog(string message, string detail)
    {
        var file = ErrorLogFile();
        if (file == null) return null;

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));

            // Keep one generation, so a repeatedly failing launch cannot fill
            // the disk and the file stays small enough to read and to email.
            try
            {
                var info = new FileInfo(file);
                if (info.Exists && info.Length > ErrorLogMaxBytes)
                {
                    var previous = file + ".previous.txt";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(file, previous);
                }
            }
            catch { }

            var block = new StringBuilder()
                .AppendLine(new string('=', 72))
                .AppendLine(DateTime.Now.ToString("g") + "   " + AppName)
                .AppendLine(new string('=', 72))
                .AppendLine(message)
                .AppendLine()
                .AppendLine(detail)
                .AppendLine()
                .AppendLine("Full technical log: " + SafeLogDir())
                .AppendLine()
                .AppendLine("What to do: send this file to your IT contact. It has everything they")
                .AppendLine("need. Nothing here is confidential beyond the file paths you chose.")
                .AppendLine()
                .ToString();

            File.AppendAllText(file, block, Encoding.UTF8);
            return file;
        }
        catch
        {
            return null;
        }
    }

    private static string SafeLogDir()
    {
        try { return LogDir(); }
        catch { return "(no writable folder was found)"; }
    }

    /// <summary>
    /// Append one line to today's log. Deliberately swallows its own errors:
    /// failing to log must never be the thing that stops the application, and
    /// the failure handler needs its line on disk before anything else.
    /// </summary>
    private static void Log(string text)
    {
        try
        {
            var file = Path.Combine(LogDir(), "pharmacy-mis-" + DateTime.Now.ToString("yyyy-MM-dd") + ".log");
            File.AppendAllText(
                file,
                DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + "  LAUNCH " + text + Environment.NewLine,
                Encoding.UTF8);
        }
        catch
        {
            // nothing sensible to do
        }
    }

    /* ---------------------------------------------------------------- *
     * Telling the user when it goes wrong
     * ---------------------------------------------------------------- */

    /// <summary>
    /// A visible, readable failure. This is a GUI-subsystem binary with no
    /// console of its own, so printing is not enough: without a dialog the
    /// customer double-clicks and simply nothing happens, which is the single
    /// worst failure mode this whole design exists to remove.
    /// </summary>
    private static int Fail(string stage, Exception err, string suggestion)
    {
        Log("FAILED at \"" + stage + "\": " + err);

        if (string.IsNullOrEmpty(suggestion))
        {
            suggestion = "Try starting the application again. If it keeps failing, "
                       + "send the error file below to your IT contact.";
        }

        var summary = new StringBuilder()
            .AppendLine(AppName + " could not start.")
            .AppendLine()
            .AppendLine("Stage that failed:  " + stage)
            .AppendLine("Error:  " + err.Message)
            .AppendLine()
            .Append(suggestion)
            .ToString();

        // Both places, and the Documents copy first in importance: this is the
        // one the customer will be asked for.
        var errorFile = WriteErrorLog(summary, err.ToString());

        var body = new StringBuilder(summary)
            .AppendLine()
            .AppendLine()
            .AppendLine(errorFile != null
                ? "The details were saved to your Documents folder:"
                : "Log file:")
            .Append(errorFile ?? SafeLogDir())
            .ToString();

        try { Console.Error.WriteLine(body); } catch { /* no console attached */ }
        try { MessageBoxW(IntPtr.Zero, body, AppName + " — could not start", MbIconError); } catch { }

        return 1;
    }

    /* ---------------------------------------------------------------- *
     * The payload
     * ---------------------------------------------------------------- */

    /// <summary>
    /// The compressed application, read out of the tail of this exe. The
    /// trailer is 24 bytes: compressed length, uncompressed length, magic.
    /// </summary>
    private static byte[] ReadPayload()
    {
        var self = Process.GetCurrentProcess().MainModule.FileName;

        using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var reader = new BinaryReader(fs))
        {
            if (fs.Length < TrailerBytes) throw new InvalidDataException("This file is too small to be complete.");

            long trailerAt = FindTrailer(fs, reader);
            if (trailerAt < 0)
            {
                throw new InvalidDataException(
                    "The application payload is missing. The file is most likely damaged or incomplete — "
                    + "re-copy it and check it against its .sha256 file.");
            }

            fs.Seek(trailerAt, SeekOrigin.Begin);
            long compressedLength = reader.ReadInt64();
            long rawLength = reader.ReadInt64();

            if (compressedLength <= 0 || compressedLength > trailerAt || rawLength <= 0)
            {
                throw new InvalidDataException("The application payload is corrupt.");
            }

            fs.Seek(trailerAt - compressedLength, SeekOrigin.Begin);
            var compressed = reader.ReadBytes((int)compressedLength);
            if (compressed.Length != compressedLength)
            {
                throw new InvalidDataException("The application payload is truncated.");
            }

            return Decompressed(compressed, (int)rawLength);
        }
    }

    /// <summary>
    /// Find the payload trailer, searching backwards from the end of the file.
    ///
    /// It is normally the last 24 bytes. It is not searched for at a fixed
    /// offset because signing the release moves it: signtool appends the
    /// Authenticode certificate to the end of the file, leaving the trailer a
    /// few kilobytes short of it. Scanning back means the exe works whether it
    /// is signed before appending, signed after, or not signed at all — rather
    /// than the release breaking the first time somebody signs it.
    /// </summary>
    private static long FindTrailer(FileStream fs, BinaryReader reader)
    {
        const int WindowBytes = 1 << 20; // far more than any certificate

        int window = (int)Math.Min(fs.Length, WindowBytes);
        fs.Seek(fs.Length - window, SeekOrigin.Begin);
        var tail = reader.ReadBytes(window);
        long tailStart = fs.Length - window;

        for (int i = tail.Length - 8; i >= 0; i--)
        {
            if (BitConverter.ToUInt64(tail, i) != TrailerMagic) continue;
            long magicAt = tailStart + i;
            long trailerAt = magicAt - 16;
            if (trailerAt >= 0) return trailerAt;
        }
        return -1;
    }

    private static byte[] Decompressed(byte[] compressed, int rawLength)
    {
        IntPtr handle;
        if (!CreateDecompressor(CompressAlgorithmLzms, IntPtr.Zero, out handle))
        {
            throw new Win32Exception(
                "Windows would not start its decompressor (cabinet.dll). Error "
                + Marshal.GetLastWin32Error() + ".");
        }

        try
        {
            var raw = new byte[rawLength];
            IntPtr used;
            if (!Decompress(handle, compressed, (IntPtr)compressed.Length, raw, (IntPtr)raw.Length, out used))
            {
                throw new InvalidDataException(
                    "The application payload could not be decompressed (Windows error "
                    + Marshal.GetLastWin32Error() + "). The file is most likely damaged.");
            }
            if ((long)used != rawLength)
            {
                throw new InvalidDataException("The application payload decompressed to the wrong size.");
            }
            return raw;
        }
        finally
        {
            CloseDecompressor(handle);
        }
    }

    /// <summary>
    /// The archive format is deliberately trivial — a 4-byte header length, a
    /// UTF-8 index, then every file's bytes end to end — because a format with
    /// no library behind it is a format that cannot go wrong at the customer's
    /// end. The index is read without a JSON parser for the same reason.
    /// </summary>
    private static int UnpackTo(byte[] raw, string target)
    {
        int headerLength = BitConverter.ToInt32(raw, 0);
        var index = Encoding.UTF8.GetString(raw, 4, headerLength);
        int bodyStart = 4 + headerLength;

        int written = 0;
        foreach (var entry in ParseIndex(index))
        {
            var full = Path.Combine(target, entry.Path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            using (var fs = new FileStream(full, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                fs.Write(raw, bodyStart + (int)entry.Offset, (int)entry.Length);
            }
            written++;
        }
        return written;
    }

    private struct Entry
    {
        public string Path;
        public long Offset;
        public long Length;
    }

    /// <summary>
    /// Reads the {"files":[{"p":..,"o":..,"l":..}],"dirs":[..]} index the build
    /// writes. Only the file entries matter — every directory is created from
    /// its file's path anyway — so this is a small scanner rather than a
    /// dependency on a JSON library.
    /// </summary>
    private static List<Entry> ParseIndex(string json)
    {
        var entries = new List<Entry>();
        int i = 0;
        while (true)
        {
            int p = json.IndexOf("\"p\":\"", i, StringComparison.Ordinal);
            if (p < 0) break;
            p += 5;
            int end = json.IndexOf('"', p);
            if (end < 0) break;
            var raw = json.Substring(p, end - p);

            int o = json.IndexOf("\"o\":", end, StringComparison.Ordinal);
            int l = json.IndexOf("\"l\":", end, StringComparison.Ordinal);
            if (o < 0 || l < 0) break;

            entries.Add(new Entry
            {
                Path = Unescape(raw),
                Offset = ReadNumber(json, o + 4),
                Length = ReadNumber(json, l + 4),
            });
            i = l + 4;
        }
        if (entries.Count == 0) throw new InvalidDataException("The application payload has an empty file index.");
        return entries;
    }

    private static string Unescape(string s)
    {
        return s.Replace("\\\\", "\\").Replace("\\\"", "\"").Replace("\\/", "/");
    }

    private static long ReadNumber(string s, int at)
    {
        long value = 0;
        while (at < s.Length && s[at] >= '0' && s[at] <= '9')
        {
            value = (value * 10) + (s[at] - '0');
            at++;
        }
        return value;
    }

    /* ---------------------------------------------------------------- *
     * Unpacking
     * ---------------------------------------------------------------- */

    private static string RuntimeDir()
    {
        return Path.Combine(BaseDir(), "runtime", BuildInfo.Version + "-" + BuildInfo.PayloadHash.Substring(0, 12));
    }

    /// <summary>Delete unpacked copies of other builds. First run of a new version only.</summary>
    private static void PruneOtherRuntimes(string keep)
    {
        try
        {
            var root = Path.Combine(BaseDir(), "runtime");
            foreach (var dir in Directory.GetDirectories(root))
            {
                if (string.Equals(dir, keep, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    Directory.Delete(dir, true);
                    Log("removed old runtime " + Path.GetFileName(dir));
                }
                catch
                {
                    // another copy may still be running out of it
                }
            }
        }
        catch
        {
            // housekeeping only — never fatal
        }
    }

    /// <summary>
    /// Make sure the application is unpacked, and return the path to its exe.
    ///
    /// The marker file goes in last and only once every file is on disk, so an
    /// unpack stopped by a crash, a full disk or an antivirus scan is redone
    /// next time rather than half-used. The unpack happens in a sibling folder
    /// and is renamed into place, so a second copy of the launcher starting at
    /// the same moment cannot see a partial tree.
    /// </summary>
    private static string EnsureUnpacked()
    {
        var dir = RuntimeDir();
        var exe = Path.Combine(dir, InnerExe);

        Func<bool> alreadyGood = () =>
        {
            try
            {
                return File.Exists(exe)
                    && File.ReadAllText(Path.Combine(dir, ".ready")).Trim() == BuildInfo.PayloadHash;
            }
            catch
            {
                return false;
            }
        };

        if (alreadyGood()) return exe;

        Log("unpacking " + BuildInfo.Version + " to " + dir);
        var staging = dir + ".unpacking-" + Process.GetCurrentProcess().Id;
        SafeDelete(staging);
        Directory.CreateDirectory(staging);

        int count = UnpackTo(ReadPayload(), staging);
        File.WriteAllText(Path.Combine(staging, ".ready"), BuildInfo.PayloadHash);

        // Two copies of the launcher can be started at the same moment on a
        // machine that has never run this build. Whichever finishes first wins;
        // the other must not delete the good tree the winner just put in place.
        if (alreadyGood())
        {
            SafeDelete(staging);
            Log("another copy unpacked it first — using that");
            return exe;
        }

        SafeDelete(dir);
        try
        {
            Directory.Move(staging, dir);
        }
        catch
        {
            if (!alreadyGood()) throw;
            SafeDelete(staging);
        }

        Log("unpacked " + count + " file(s)");
        PruneOtherRuntimes(dir);

        if (!File.Exists(exe))
        {
            throw new FileNotFoundException("The application did not unpack correctly: " + InnerExe + " is missing.");
        }
        return exe;
    }

    private static void SafeDelete(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
    }

    /* ---------------------------------------------------------------- *
     * Go
     * ---------------------------------------------------------------- */

    [STAThread]
    private static int Main()
    {
        string exe;
        try
        {
            exe = EnsureUnpacked();
        }
        catch (Exception err)
        {
            var text = err.Message ?? string.Empty;
            string suggestion = null;
            if (err is IOException && text.IndexOf("enough space", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                suggestion = "The disk is full. Free up about 500 MB and start the application again.";
            }
            else if (err is UnauthorizedAccessException)
            {
                suggestion = "Windows or your antivirus blocked the application from unpacking into your "
                           + "user folder. Ask your IT contact to allow " + SafeRuntimePath() + ".";
            }
            return Fail("unpacking the application", err, suggestion);
        }

        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                // Required both to inherit this process's stdout/stderr handles
                // (which is how --cli output reaches whatever spawned us) and to
                // be allowed to change the child's environment below.
                UseShellExecute = false,
                Arguments = ForwardedArguments(),
                WorkingDirectory = Path.GetDirectoryName(exe),
            };

            // ELECTRON_RUN_AS_NODE turns Electron into a bare Node runtime and
            // would stop the window ever appearing. It is set by other Electron
            // tooling and inherited by anything started from the same session,
            // so it is cleared here rather than trusted.
            psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            psi.EnvironmentVariables.Remove("ELECTRON_NO_ATTACH_CONSOLE");

            using (var child = Process.Start(psi))
            {
                child.WaitForExit();
                Log("application exited (" + child.ExitCode + ")");
                return child.ExitCode;
            }
        }
        catch (Exception err)
        {
            return Fail("starting the application", err, null);
        }
    }

    private static string SafeRuntimePath()
    {
        try { return Path.Combine(BaseDir(), "runtime"); }
        catch { return @"%LOCALAPPDATA%\" + AppDirName + @"\runtime"; }
    }

    /// <summary>
    /// This launcher's own arguments, re-quoted for the application. Windows
    /// hands programs a single command line rather than a list, so an argument
    /// containing spaces — every file path the customer picks — has to be put
    /// back in quotes or it arrives as two arguments.
    /// </summary>
    private static string ForwardedArguments()
    {
        var args = Environment.GetCommandLineArgs();
        var quoted = new List<string>();
        for (int i = 1; i < args.Length; i++) quoted.Add(Quote(args[i]));
        return string.Join(" ", quoted.ToArray());
    }

    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;

        var sb = new StringBuilder("\"");
        for (int i = 0; i < arg.Length; i++)
        {
            int slashes = 0;
            while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }

            if (i == arg.Length)
            {
                // Backslashes immediately before the closing quote must be doubled.
                sb.Append('\\', slashes * 2);
                break;
            }
            if (arg[i] == '"')
            {
                sb.Append('\\', (slashes * 2) + 1).Append('"');
            }
            else
            {
                sb.Append('\\', slashes).Append(arg[i]);
            }
        }
        return sb.Append('"').ToString();
    }
}

/// <summary>A Win32 failure with a message written for the person reading it.</summary>
internal sealed class Win32Exception : Exception
{
    public Win32Exception(string message) : base(message) { }
}
