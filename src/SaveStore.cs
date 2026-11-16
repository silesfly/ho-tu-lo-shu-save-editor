using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace HoTuLoShuSaveEditor
{
    public static class SaveStore
    {
        public const long MaxSaveBytes = 32L * 1024L * 1024L;
        public const long MaxUncompressedSaveBytes = 96L * 1024L * 1024L;
        public const int MaxMsgPackDepth = 64;

        private static readonly string[] ReservedDeviceNames = new string[]
        {
            "CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9",
            "LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"
        };

        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
        private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
        private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
        private const int FileRenameInfoClass = 3;
        private const int FileDispositionInfoClass = 4;
        private const uint VOLUME_NAME_DOS = 0;

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint dwFileAttributes;
            public FILETIME ftCreationTime;
            public FILETIME ftLastAccessTime;
            public FILETIME ftLastWriteTime;
            public uint dwVolumeSerialNumber;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint nNumberOfLinks;
            public uint nFileIndexHigh;
            public uint nFileIndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint dwLowDateTime;
            public uint dwHighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_RENAME_INFO
        {
            [MarshalAs(UnmanagedType.U1)]
            public bool ReplaceIfExists;
            public IntPtr RootDirectory;
            public uint FileNameLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 1)]
            public char[] FileName;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_DISPOSITION_INFO
        {
            [MarshalAs(UnmanagedType.U1)]
            public bool DeleteFile;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle hFile,
            out BY_HANDLE_FILE_INFORMATION lpFileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle hFile,
            StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle hFile,
            int FileInformationClass,
            IntPtr lpFileInformation,
            uint dwBufferSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileExW(
            string lpExistingFileName,
            string lpNewFileName,
            uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FlushFileBuffers(SafeFileHandle hFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr hObject);

        public static bool HasInvalidColon(string path)
        {
            if (path == null) return true;
            for (int i = 0; i < path.Length; i++)
            {
                if (path[i] != ':') continue;
                if (i == 1 && path.Length >= 3 && IsAsciiLetter(path[0]) &&
                    (path[2] == '\\' || path[2] == '/'))
                {
                    continue;
                }
                return true;
            }
            return false;
        }

        public static bool IsReservedDeviceName(string stem)
        {
            if (stem == null) return true;
            string name = stem.TrimEnd(' ', '.');
            int dot = name.IndexOf('.');
            if (dot >= 0) name = name.Substring(0, dot);
            if (name.Length == 0) return false;
            for (int i = 0; i < ReservedDeviceNames.Length; i++)
            {
                if (string.Equals(name, ReservedDeviceNames[i], StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        public static bool IsSaveExtension(string path)
        {
            if (path == null) return false;
            string ext = Path.GetExtension(path);
            return string.Equals(ext, ".save", StringComparison.OrdinalIgnoreCase);
        }

        public static void NoLinks(string path)
        {
            if (string.IsNullOrEmpty(path))
                throw new ArgumentException("경로가 비어 있습니다.", "path");
            if (HasInvalidColon(path))
                throw new InvalidDataException("경로에 허용되지 않는 콜론(ADS)이 포함되어 있습니다.");
            if (path.StartsWith("\\\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal))
                throw new InvalidDataException("UNC 경로는 지원하지 않습니다.");

            string[] parts = path.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; i++)
            {
                if (parts[i] == "..")
                    throw new InvalidDataException("상위 경로(..)가 포함된 경로는 지원하지 않습니다.");
            }

            string full;
            try { full = Path.GetFullPath(path); }
            catch (Exception ex) { throw new InvalidDataException("경로를 정규화할 수 없습니다.", ex); }

            if (full.StartsWith("\\\\", StringComparison.Ordinal) || full.StartsWith("//", StringComparison.Ordinal))
                throw new InvalidDataException("UNC 경로는 지원하지 않습니다.");

            string fileName = Path.GetFileName(full);
            string stem = Path.GetFileNameWithoutExtension(fileName);
            if (IsReservedDeviceName(stem))
                throw new InvalidDataException("예약된 장치 이름은 저장 파일로 사용할 수 없습니다.");

            if (Directory.Exists(full))
                throw new InvalidDataException("저장 파일 경로가 디렉터리입니다.");
            if (File.Exists(full))
            {
                FileAttributes attrs = File.GetAttributes(full);
                if ((attrs & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("저장 파일이 심볼릭 링크/재분석 지점입니다.");
            }

            string dir = Path.GetDirectoryName(full);
            while (!string.IsNullOrEmpty(dir))
            {
                if (Directory.Exists(dir))
                {
                    FileAttributes attrs = File.GetAttributes(dir);
                    if ((attrs & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException("상위 디렉터리에 재분석 지점이 포함되어 있습니다.");
                }
                string parent = Path.GetDirectoryName(dir);
                if (parent == null || parent.Length == 0 || string.Equals(parent, dir, StringComparison.OrdinalIgnoreCase))
                    break;
                dir = parent;
            }
        }

        public static void VerifyHandle(FileStream stream, string expectedFullPath)
        {
            if (stream == null || stream.SafeFileHandle == null || stream.SafeFileHandle.IsInvalid)
                throw new InvalidDataException("유효하지 않은 파일 핸들입니다.");
            VerifyHandle(stream.SafeFileHandle, expectedFullPath);
        }

        private static void VerifyHandle(SafeFileHandle handle, string expectedFullPath)
        {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new InvalidDataException("파일 핸들 정보를 읽을 수 없습니다.");
            if ((info.dwFileAttributes & (uint)FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("파일 핸들이 재분석 지점을 가리킵니다.");
            if (info.nNumberOfLinks != 1)
                throw new InvalidDataException("하드 링크가 있는 파일은 저장할 수 없습니다.");

            StringBuilder sb = new StringBuilder(1024);
            uint len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, VOLUME_NAME_DOS);
            if (len == 0)
                throw new InvalidDataException("파일 최종 경로를 확인할 수 없습니다.");
            if (len >= sb.Capacity)
            {
                sb = new StringBuilder((int)len + 1);
                len = GetFinalPathNameByHandleW(handle, sb, (uint)sb.Capacity, VOLUME_NAME_DOS);
                if (len == 0 || len >= sb.Capacity)
                    throw new InvalidDataException("파일 최종 경로를 확인할 수 없습니다.");
            }

            string finalPath = sb.ToString();
            if (finalPath.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("UNC 최종 경로는 지원하지 않습니다.");

            string normalizedFinal = NormalizeFinalPath(finalPath);
            string normalizedExpected = Path.GetFullPath(expectedFullPath);
            if (!string.Equals(normalizedFinal, normalizedExpected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("파일 핸들의 실제 경로가 예상 경로와 다릅니다.");
        }

        private static string NormalizeFinalPath(string path)
        {
            if (path.StartsWith("\\\\?\\", StringComparison.Ordinal))
                path = path.Substring(4);
            if (path.StartsWith("UNC\\", StringComparison.OrdinalIgnoreCase))
                path = "\\\\" + path.Substring(4);
            return Path.GetFullPath(path);
        }

        public static List<SafeFileHandle> PinAncestorDirectories(string targetFullPath, List<SafeFileHandle> pinned)
        {
            if (pinned == null) pinned = new List<SafeFileHandle>();
            string full = Path.GetFullPath(targetFullPath);
            string dir = Path.GetDirectoryName(full);
            List<string> dirs = new List<string>();
            while (!string.IsNullOrEmpty(dir))
            {
                dirs.Add(dir);
                string parent = Path.GetDirectoryName(dir);
                if (parent == null || parent.Length == 0 || string.Equals(parent, dir, StringComparison.OrdinalIgnoreCase))
                    break;
                dir = parent;
            }

            for (int i = dirs.Count - 1; i >= 0; i--)
            {
                string current = dirs[i];
                if (!Directory.Exists(current))
                    throw new DirectoryNotFoundException("상위 디렉터리를 찾을 수 없습니다: " + current);

                SafeFileHandle h = CreateFileW(
                    current,
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    IntPtr.Zero,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    IntPtr.Zero);
                if (h.IsInvalid)
                    throw new IOException("상위 디렉터리 핸들을 열 수 없습니다. Win32 오류: " + Marshal.GetLastWin32Error());

                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(h, out info))
                {
                    h.Dispose();
                    throw new IOException("상위 디렉터리 정보를 읽을 수 없습니다. Win32 오류: " + Marshal.GetLastWin32Error());
                }
                if ((info.dwFileAttributes & (uint)FileAttributes.ReparsePoint) != 0)
                {
                    h.Dispose();
                    throw new InvalidDataException("상위 디렉터리에 재분석 지점이 포함되어 있습니다.");
                }
                pinned.Add(h);
            }
            return pinned;
        }

        public static bool IsGameRunning()
        {
            string sim = Environment.GetEnvironmentVariable("HTLS_SIMULATE_GAME_RUNNING");
            if (string.Equals(sim, "1", StringComparison.Ordinal))
                return true;
            Process[] procs = Process.GetProcessesByName("J2");
            try
            {
                return procs.Length > 0;
            }
            finally
            {
                for (int i = 0; i < procs.Length; i++)
                {
                    try { procs[i].Dispose(); } catch { }
                }
            }
        }

        public static byte[] Read(string path)
        {
            NoLinks(path);
            if (!IsSaveExtension(path))
                throw new InvalidDataException(".save 확장자만 읽을 수 있습니다.");

            string full = Path.GetFullPath(path);
            using (FileStream fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan))
            {
                VerifyHandle(fs, full);
                if (fs.Length > MaxSaveBytes)
                    throw new InvalidDataException("저장 파일이 최대 허용 크기를 초과했습니다.");
                byte[] bytes = new byte[(int)fs.Length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int n = fs.Read(bytes, offset, bytes.Length - offset);
                    if (n <= 0) throw new InvalidDataException("저장 파일을 읽는 중 예기치 않게 끝났습니다.");
                    offset += n;
                }
                ValidateSaveBytes(bytes);
                return bytes;
            }
        }

        public static string Hash(byte[] bytes)
        {
            if (bytes == null) throw new ArgumentNullException("bytes");
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++)
                    sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }

        public static List<string> DiscoverSavePaths()
        {
            List<string> result = new List<string>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(userProfile))
            {
                AddSteamUserDataSaves(Path.Combine(userProfile, "AppData", "Local", "Steam", "userdata"), result, seen);
                string localLow = Path.Combine(userProfile, "AppData", "LocalLow", "Heluo", "J2");
                AddSavesFromDirectory(localLow, result, seen);
            }

            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            if (!string.IsNullOrEmpty(pf86))
                AddSteamUserDataSaves(Path.Combine(pf86, "Steam", "userdata"), result, seen);
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (!string.IsNullOrEmpty(pf))
                AddSteamUserDataSaves(Path.Combine(pf, "Steam", "userdata"), result, seen);

            DriveInfo[] drives = null;
            try { drives = DriveInfo.GetDrives(); } catch { drives = null; }
            if (drives != null)
            {
                for (int i = 0; i < drives.Length; i++)
                {
                    try
                    {
                        if (!drives[i].IsReady) continue;
                        if (drives[i].DriveType != DriveType.Fixed && drives[i].DriveType != DriveType.Removable) continue;
                        AddSteamLibrarySaves(drives[i].RootDirectory.FullName, result, seen);
                    }
                    catch { }
                }
            }

            result.Sort(StringComparer.OrdinalIgnoreCase);
            return result;
        }

        private static void AddSteamUserDataSaves(string userdata, List<string> result, HashSet<string> seen)
        {
            if (!SafeDirectoryExists(userdata)) return;
            string[] users;
            try { users = Directory.GetDirectories(userdata); }
            catch { return; }
            for (int i = 0; i < users.Length; i++)
            {
                string remote = Path.Combine(users[i], "952860", "remote");
                AddSavesFromDirectory(remote, result, seen);
            }
        }

        private static void AddSteamLibrarySaves(string root, List<string> result, HashSet<string> seen)
        {
            string steamApps = Path.Combine(root, "SteamLibrary", "steamapps");
            string common = Path.Combine(steamApps, "common");
            if (SafeDirectoryExists(common))
                AddHeluoSaveDirectory(common, result, seen);
            string altCommon = Path.Combine(root, "steamapps", "common");
            if (SafeDirectoryExists(altCommon))
                AddHeluoSaveDirectory(altCommon, result, seen);
        }

        private static void AddHeluoSaveDirectory(string common, List<string> result, HashSet<string> seen)
        {
            string[] dirs;
            try { dirs = Directory.GetDirectories(common, "河洛群俠傳*"); }
            catch { return; }
            for (int i = 0; i < dirs.Length; i++)
            {
                string saveData = Path.Combine(dirs[i], "SaveData");
                AddSavesFromDirectory(saveData, result, seen);
            }
        }

        private static void AddSavesFromDirectory(string dir, List<string> result, HashSet<string> seen)
        {
            if (!SafeDirectoryExists(dir)) return;
            string[] files;
            try { files = Directory.GetFiles(dir, "*.save", SearchOption.TopDirectoryOnly); }
            catch { return; }
            for (int i = 0; i < files.Length; i++)
            {
                string f = Path.GetFullPath(files[i]);
                if (!IsSaveExtension(f)) continue;
                if (HasInvalidColon(f)) continue;
                if (seen.Add(f)) result.Add(f);
            }
        }

        private static bool SafeDirectoryExists(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return false;
                FileAttributes attrs = File.GetAttributes(dir);
                if ((attrs & FileAttributes.ReparsePoint) != 0) return false;
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static string SaveWithBackup(string targetPath, byte[] newBytes, string expectedOrigSha256OrNull)
        {
            if (newBytes == null) throw new ArgumentNullException("newBytes");
            if (IsGameRunning())
                throw new InvalidOperationException("게임(J2.exe)이 실행 중입니다. 게임을 종료한 뒤 저장하세요.");

            NoLinks(targetPath);
            if (!IsSaveExtension(targetPath))
                throw new InvalidDataException(".save 확장자만 저장할 수 있습니다.");
            ValidateSaveBytes(newBytes);

            string full = Path.GetFullPath(targetPath);
            string dir = Path.GetDirectoryName(full);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                throw new DirectoryNotFoundException("저장 폴더를 찾을 수 없습니다.");

            string stem = Path.GetFileNameWithoutExtension(full);
            if (IsReservedDeviceName(stem))
                throw new InvalidDataException("예약된 장치 이름은 저장 파일로 사용할 수 없습니다.");

            string lockPath = full + ".lock";
            FileStream lockStream = null;
            List<SafeFileHandle> pinned = new List<SafeFileHandle>();
            string pendingPath = null;
            string backupPath = null;
            try
            {
                try
                {
                    lockStream = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                }
                catch (IOException ex)
                {
                    throw new InvalidOperationException("저장 파일 잠금을 획득할 수 없습니다. 다른 편집기가 저장 중일 수 있습니다.", ex);
                }

                PinAncestorDirectories(full, pinned);

                byte[] oldBytes = null;
                if (File.Exists(full))
                {
                    using (FileStream oldFs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.None))
                    {
                        VerifyHandle(oldFs, full);
                        if (oldFs.Length > MaxSaveBytes)
                            throw new InvalidDataException("기존 저장 파일이 최대 허용 크기를 초과했습니다.");
                        oldBytes = new byte[(int)oldFs.Length];
                        int off = 0;
                        while (off < oldBytes.Length)
                        {
                            int n = oldFs.Read(oldBytes, off, oldBytes.Length - off);
                            if (n <= 0) throw new InvalidDataException("기존 저장 파일을 읽는 중 예기치 않게 끝났습니다.");
                            off += n;
                        }
                        ValidateSaveBytes(oldBytes);
                    }
                }

                if (!string.IsNullOrEmpty(expectedOrigSha256OrNull))
                {
                    if (oldBytes == null)
                        throw new InvalidDataException("기존 저장 파일이 없어 원본 해시를 검증할 수 없습니다.");
                    string actual = Hash(oldBytes);
                    if (!string.Equals(actual, expectedOrigSha256OrNull, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("원본 저장 파일 해시가 예상 값과 다릅니다. 다른 프로그램이 파일을 변경했습니다.");
                }

                if (oldBytes != null)
                {
                    string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
                    string rand = Guid.NewGuid().ToString("N").Substring(0, 8);
                    backupPath = full + ".backup-" + stamp + "-" + rand + ".bak";
                    WriteBytesWithVerify(backupPath, oldBytes, false);
                    string backupHash = Hash(oldBytes);
                    byte[] backupRead = File.ReadAllBytes(backupPath);
                    if (!string.Equals(Hash(backupRead), backupHash, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("백업 파일 해시 검증에 실패했습니다.");
                }

                pendingPath = full + ".pending-" + Guid.NewGuid().ToString("N");
                WriteBytesWithVerify(pendingPath, newBytes, true);

                bool moved = false;
                try
                {
                    uint flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
                    moved = MoveFileExW(pendingPath, full, flags);
                    if (!moved)
                        throw new IOException("원자적 파일 교체에 실패했습니다. Win32 오류: " + Marshal.GetLastWin32Error());
                    pendingPath = null;
                }
                catch
                {
                    RollbackPendingAndOriginal(full, pendingPath, backupPath);
                    throw;
                }

                return backupPath;
            }
            finally
            {
                if (lockStream != null)
                {
                    try { lockStream.Dispose(); } catch { }
                }
                for (int i = 0; i < pinned.Count; i++)
                {
                    try { pinned[i].Dispose(); } catch { }
                }
                if (pendingPath != null)
                {
                    try { if (File.Exists(pendingPath)) File.Delete(pendingPath); } catch { }
                }
                try
                {
                    if (File.Exists(lockPath)) File.Delete(lockPath);
                }
                catch { }
            }
        }

        private static void WriteBytesWithVerify(string path, byte[] bytes, bool flushToDisk)
        {
            using (FileStream fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                fs.Write(bytes, 0, bytes.Length);
                if (flushToDisk)
                    fs.Flush(true);
                else
                    fs.Flush();
            }
            byte[] readBack = File.ReadAllBytes(path);
            string h1 = Hash(bytes);
            string h2 = Hash(readBack);
            if (!string.Equals(h1, h2, StringComparison.OrdinalIgnoreCase))
                throw new IOException("파일 쓰기 검증에 실패했습니다: " + path);
        }

        private static void RollbackPendingAndOriginal(string full, string pendingPath, string backupPath)
        {
            if (pendingPath != null)
            {
                try { if (File.Exists(pendingPath)) File.Delete(pendingPath); } catch { }
            }
            if (!string.IsNullOrEmpty(backupPath) && File.Exists(backupPath))
            {
                try
                {
                    if (!File.Exists(full))
                        File.Copy(backupPath, full, false);
                }
                catch { }
            }
        }

        public static void ValidateSaveBytes(byte[] bytes)
        {
            if (bytes == null || bytes.Length < 18)
                throw new InvalidDataException("저장 파일이 너무 짧습니다.");
            if (bytes.Length > MaxSaveBytes)
                throw new InvalidDataException("저장 파일이 최대 허용 크기를 초과했습니다.");

            byte[] magic1 = Encoding.ASCII.GetBytes("HELUO_1_0");
            byte[] magic2 = Encoding.ASCII.GetBytes("HELUO_1_1");
            bool magicOk = MatchAt(bytes, 0, magic1) || MatchAt(bytes, 0, magic2);
            if (!magicOk)
                throw new InvalidDataException("하락군협전 저장 파일 매직 값이 올바르지 않습니다.");

            int pos = 9;
            byte[] block0 = ReadLz4ExtBlock(bytes, ref pos);
            byte[] block1 = ReadLz4ExtBlock(bytes, ref pos);
            if (pos != bytes.Length)
                throw new InvalidDataException("저장 파일 뒤에 예기치 않은 추가 데이터가 있습니다.");

            if (!IsMsgPackMapHeader(block0, 0, block0.Length))
                throw new InvalidDataException("첫 번째 압축 블록이 MessagePack 맵이 아닙니다.");

            bool hasCharacter = false;
            bool hasTeammates = false;
            ScanTopLevelMapKeysBlock1(block1, ref hasCharacter, ref hasTeammates);
            if (!hasCharacter || !hasTeammates)
                throw new InvalidDataException("두 번째 압축 블록에 Character 또는 Teammates 키가 없습니다.");
        }

        private static bool MatchAt(byte[] data, int offset, byte[] pattern)
        {
            if (offset < 0 || offset + pattern.Length > data.Length) return false;
            for (int i = 0; i < pattern.Length; i++)
                if (data[offset + i] != pattern[i]) return false;
            return true;
        }

        private static byte[] ReadLz4ExtBlock(byte[] bytes, ref int pos)
        {
            if (pos >= bytes.Length)
                throw new InvalidDataException("압축 블록 헤더가 잘렸습니다.");

            byte code = bytes[pos++];
            long extLen;
            if (code == 0xc7)
            {
                extLen = ReadUInt8(bytes, ref pos);
            }
            else if (code == 0xc8)
            {
                extLen = ReadUInt16BE(bytes, ref pos);
            }
            else if (code == 0xc9)
            {
                extLen = ReadUInt32BE(bytes, ref pos);
            }
            else
            {
                throw new InvalidDataException("LZ4 MessagePack 확장 블록 헤더가 올바르지 않습니다.");
            }

            if (extLen < 1 || extLen > MaxSaveBytes)
                throw new InvalidDataException("LZ4 확장 블록 길이가 올바르지 않습니다.");

            if (pos >= bytes.Length)
                throw new InvalidDataException("LZ4 확장 타입이 잘렸습니다.");
            sbyte extType = unchecked((sbyte)bytes[pos++]);
            if (extType != 99)
                throw new InvalidDataException("LZ4 확장 타입(99)이 아닙니다.");

            if (pos + extLen > bytes.Length)
                throw new InvalidDataException("LZ4 압축 페이로드가 잘렸습니다.");

            int dataEnd = pos + (int)extLen;
            long uncompressedLen = ReadMsgPackIntFromBytes(bytes, ref pos);
            if (uncompressedLen < 0 || uncompressedLen > MaxUncompressedSaveBytes)
                throw new InvalidDataException("압축 해제 예상 길이가 허용 범위를 벗어났습니다.");

            int compressedLen = dataEnd - pos;
            if (compressedLen < 0)
                throw new InvalidDataException("LZ4 압축 데이터 길이가 올바르지 않습니다.");

            byte[] compressed = new byte[compressedLen];
            Buffer.BlockCopy(bytes, pos, compressed, 0, compressedLen);
            pos = dataEnd;

            byte[] output;
            try
            {
                output = Lz4DecompressBlock(compressed, (int)uncompressedLen);
            }
            catch (Exception ex)
            {
                throw new InvalidDataException("LZ4 압축 해제 중 손상이 발견되었습니다.", ex);
            }

            if (output.Length != (int)uncompressedLen)
                throw new InvalidDataException("LZ4 압축 해제 결과 길이가 예상과 다릅니다.");
            return output;
        }

        private static int ReadUInt8(byte[] bytes, ref int pos)
        {
            if (pos + 1 > bytes.Length) throw new InvalidDataException("바이트가 잘렸습니다.");
            return bytes[pos++];
        }

        private static int ReadUInt16BE(byte[] bytes, ref int pos)
        {
            if (pos + 2 > bytes.Length) throw new InvalidDataException("바이트가 잘렸습니다.");
            int v = (bytes[pos] << 8) | bytes[pos + 1];
            pos += 2;
            return v;
        }

        private static long ReadUInt32BE(byte[] bytes, ref int pos)
        {
            if (pos + 4 > bytes.Length) throw new InvalidDataException("바이트가 잘렸습니다.");
            long v = ((long)bytes[pos] << 24) | ((long)bytes[pos + 1] << 16) |
                     ((long)bytes[pos + 2] << 8) | bytes[pos + 3];
            pos += 4;
            return v;
        }

        private static long ReadMsgPackIntFromBytes(byte[] bytes, ref int pos)
        {
            if (pos >= bytes.Length) throw new InvalidDataException("MessagePack 정수가 잘렸습니다.");
            byte b = bytes[pos++];
            if (b <= 0x7f) return b;
            if (b >= 0xe0) return unchecked((sbyte)b);
            if (b == 0xcc)
            {
                if (pos + 1 > bytes.Length) throw new InvalidDataException("MessagePack uint8이 잘렸습니다.");
                return bytes[pos++];
            }
            if (b == 0xcd)
            {
                if (pos + 2 > bytes.Length) throw new InvalidDataException("MessagePack uint16이 잘렸습니다.");
                int v = (bytes[pos] << 8) | bytes[pos + 1];
                pos += 2;
                return v;
            }
            if (b == 0xce)
            {
                if (pos + 4 > bytes.Length) throw new InvalidDataException("MessagePack uint32이 잘렸습니다.");
                long v = ((long)bytes[pos] << 24) | ((long)bytes[pos + 1] << 16) |
                         ((long)bytes[pos + 2] << 8) | bytes[pos + 3];
                pos += 4;
                return v;
            }
            if (b == 0xcf)
            {
                if (pos + 8 > bytes.Length) throw new InvalidDataException("MessagePack uint64이 잘렸습니다.");
                ulong v = 0;
                for (int i = 0; i < 8; i++) v = (v << 8) | bytes[pos++];
                if (v > long.MaxValue) throw new InvalidDataException("MessagePack uint64 값이 너무 큽니다.");
                return (long)v;
            }
            if (b == 0xd0)
            {
                if (pos + 1 > bytes.Length) throw new InvalidDataException("MessagePack int8이 잘렸습니다.");
                return unchecked((sbyte)bytes[pos++]);
            }
            if (b == 0xd1)
            {
                if (pos + 2 > bytes.Length) throw new InvalidDataException("MessagePack int16이 잘렸습니다.");
                short v = unchecked((short)((bytes[pos] << 8) | bytes[pos + 1]));
                pos += 2;
                return v;
            }
            if (b == 0xd2)
            {
                if (pos + 4 > bytes.Length) throw new InvalidDataException("MessagePack int32가 잘렸습니다.");
                int v = unchecked((int)(((uint)bytes[pos] << 24) | ((uint)bytes[pos + 1] << 16) |
                                       ((uint)bytes[pos + 2] << 8) | bytes[pos + 3]));
                pos += 4;
                return v;
            }
            if (b == 0xd3)
            {
                if (pos + 8 > bytes.Length) throw new InvalidDataException("MessagePack int64가 잘렸습니다.");
                long v = 0;
                for (int i = 0; i < 8; i++) v = (v << 8) | bytes[pos++];
                return v;
            }
            throw new InvalidDataException("LZ4 블록 앞에 MessagePack 정수가 아닌 값이 있습니다.");
        }

        private static byte[] Lz4DecompressBlock(byte[] input, int expectedLen)
        {
            if (expectedLen < 0 || expectedLen > MaxUncompressedSaveBytes)
                throw new InvalidDataException("LZ4 압축 해제 길이가 허용 범위를 벗어났습니다.");
            if (expectedLen == 0)
            {
                if (input.Length != 0) throw new InvalidDataException("LZ4 빈 블록이 올바르지 않습니다.");
                return new byte[0];
            }

            byte[] output = new byte[expectedLen];
            int ip = 0;
            int op = 0;

            while (true)
            {
                if (ip >= input.Length) throw new InvalidDataException("LZ4 토큰이 잘렸습니다.");
                int token = input[ip++];
                int literalLen = token >> 4;
                if (literalLen == 15)
                {
                    int add;
                    do
                    {
                        if (ip >= input.Length) throw new InvalidDataException("LZ4 리터럴 길이가 잘렸습니다.");
                        add = input[ip++];
                        literalLen += add;
                        if (literalLen < 0 || literalLen > expectedLen) throw new InvalidDataException("LZ4 리터럴 길이가 너무 큽니다.");
                    } while (add == 255);
                }

                if (literalLen > 0)
                {
                    if (ip + literalLen > input.Length) throw new InvalidDataException("LZ4 리터럴 데이터가 잘렸습니다.");
                    if (op + literalLen > output.Length) throw new InvalidDataException("LZ4 출력 버퍼를 초과했습니다.");
                    Buffer.BlockCopy(input, ip, output, op, literalLen);
                    ip += literalLen;
                    op += literalLen;
                }

                if (ip == input.Length)
                    break;

                if (ip + 2 > input.Length) throw new InvalidDataException("LZ4 매치 오프셋이 잘렸습니다.");
                int offset = input[ip] | (input[ip + 1] << 8);
                ip += 2;
                if (offset <= 0 || offset > op)
                    throw new InvalidDataException("LZ4 매치 오프셋이 올바르지 않습니다.");

                int matchLen = token & 0x0f;
                if (matchLen == 15)
                {
                    int add;
                    do
                    {
                        if (ip >= input.Length) throw new InvalidDataException("LZ4 매치 길이가 잘렸습니다.");
                        add = input[ip++];
                        matchLen += add;
                        if (matchLen < 0 || matchLen > expectedLen) throw new InvalidDataException("LZ4 매치 길이가 너무 큽니다.");
                    } while (add == 255);
                }
                matchLen += 4;

                if (op + matchLen > output.Length) throw new InvalidDataException("LZ4 출력 버퍼를 초과했습니다.");
                int matchPos = op - offset;
                for (int i = 0; i < matchLen; i++)
                    output[op + i] = output[matchPos + i];
                op += matchLen;
            }

            if (op != expectedLen)
                throw new InvalidDataException("LZ4 압축 해제 결과 길이가 예상과 다릅니다.");
            return output;
        }

        private static bool IsMsgPackMapHeader(byte[] data, int offset, int length)
        {
            if (offset < 0 || offset >= length) return false;
            byte b = data[offset];
            if (b >= 0x80 && b <= 0x8f) return true;
            if (b == 0xde)
                return offset + 3 <= length;
            if (b == 0xdf)
                return offset + 5 <= length;
            return false;
        }

        private static bool IsMsgPackMapHeader(byte[] data)
        {
            return IsMsgPackMapHeader(data, 0, data.Length);
        }

        private static void ScanTopLevelMapKeysBlock1(byte[] data, ref bool hasCharacter, ref bool hasTeammates)
        {
            int pos = 0;
            if (!IsMsgPackMapHeader(data, pos, data.Length))
                throw new InvalidDataException("두 번째 압축 블록이 MessagePack 맵이 아닙니다.");

            byte b = data[pos++];
            long count = 0;
            if (b >= 0x80 && b <= 0x8f)
            {
                count = b & 0x0f;
            }
            else if (b == 0xde)
            {
                if (pos + 2 > data.Length) throw new InvalidDataException("MessagePack 맵16 헤더가 잘렸습니다.");
                count = (data[pos] << 8) | data[pos + 1];
                pos += 2;
            }
            else if (b == 0xdf)
            {
                if (pos + 4 > data.Length) throw new InvalidDataException("MessagePack 맵32 헤더가 잘렸습니다.");
                long v = ((long)data[pos] << 24) | ((long)data[pos + 1] << 16) |
                         ((long)data[pos + 2] << 8) | data[pos + 3];
                pos += 4;
                count = v;
            }
            else
            {
                throw new InvalidDataException("두 번째 압축 블록이 MessagePack 맵이 아닙니다.");
            }

            if (count < 0 || count > 10000000L)
                throw new InvalidDataException("MessagePack 맵 항목 수가 비정상적으로 큽니다.");

            for (long i = 0; i < count; i++)
            {
                int keyStart = pos;
                MpSkip(data, ref pos, 0);
                int keyEnd = pos;

                string key = TryReadMsgPackString(data, keyStart, keyEnd);
                if (key != null)
                {
                    if (string.Equals(key, "Character", StringComparison.Ordinal)) hasCharacter = true;
                    if (string.Equals(key, "Teammates", StringComparison.Ordinal)) hasTeammates = true;
                }

                MpSkip(data, ref pos, 0);
            }

            if (pos != data.Length)
                throw new InvalidDataException("두 번째 압축 블록에 예기치 않은 추가 데이터가 있습니다.");
        }

        private static string TryReadMsgPackString(byte[] data, int start, int end)
        {
            if (start < 0 || end > data.Length || start >= end) return null;
            int pos = start;
            byte b = data[pos++];
            int len = -1;
            int header = 1;

            if (b >= 0xa0 && b <= 0xbf)
            {
                len = b & 0x1f;
            }
            else if (b == 0xd9)
            {
                if (pos + 1 > end) return null;
                len = data[pos];
                header = 2;
            }
            else if (b == 0xda)
            {
                if (pos + 2 > end) return null;
                len = (data[pos] << 8) | data[pos + 1];
                header = 3;
            }
            else if (b == 0xdb)
            {
                if (pos + 4 > end) return null;
                long l = ((long)data[pos] << 24) | ((long)data[pos + 1] << 16) |
                         ((long)data[pos + 2] << 8) | data[pos + 3];
                if (l > int.MaxValue) return null;
                len = (int)l;
                header = 5;
            }
            else
            {
                return null;
            }

            if (len < 0 || start + header + len != end) return null;
            try
            {
                return Encoding.UTF8.GetString(data, start + header, len);
            }
            catch
            {
                return null;
            }
        }

        private static void MpSkip(byte[] data, ref int pos, int depth)
        {
            if (depth > MaxMsgPackDepth)
                throw new InvalidDataException("MessagePack 중첩 깊이가 최대 허용치를 초과했습니다.");
            if (pos >= data.Length)
                throw new InvalidDataException("MessagePack 데이터가 잘렸습니다.");

            byte b = data[pos++];
            if (b <= 0x7f) return;
            if (b >= 0xe0) return;
            if (b >= 0x80 && b <= 0x8f) { SkipMap(data, ref pos, b & 0x0f, depth); return; }
            if (b >= 0x90 && b <= 0x9f) { SkipArray(data, ref pos, b & 0x0f, depth); return; }
            if (b >= 0xa0 && b <= 0xbf) { SkipBytes(data, ref pos, b & 0x1f); return; }

            switch (b)
            {
                case 0xc0:
                case 0xc2:
                case 0xc3:
                    return;
                case 0xc4:
                    SkipBytes(data, ref pos, ReadU8(data, ref pos));
                    return;
                case 0xc5:
                    SkipBytes(data, ref pos, ReadU16(data, ref pos));
                    return;
                case 0xc6:
                    SkipBytes(data, ref pos, ReadI32Len(data, ref pos));
                    return;
                case 0xc7:
                    SkipExt(data, ref pos, ReadU8(data, ref pos));
                    return;
                case 0xc8:
                    SkipExt(data, ref pos, ReadU16(data, ref pos));
                    return;
                case 0xc9:
                    SkipExt(data, ref pos, ReadI32Len(data, ref pos));
                    return;
                case 0xca:
                    SkipBytes(data, ref pos, 4);
                    return;
                case 0xcb:
                    SkipBytes(data, ref pos, 8);
                    return;
                case 0xcc:
                case 0xd0:
                    SkipBytes(data, ref pos, 1);
                    return;
                case 0xcd:
                case 0xd1:
                    SkipBytes(data, ref pos, 2);
                    return;
                case 0xce:
                case 0xd2:
                    SkipBytes(data, ref pos, 4);
                    return;
                case 0xcf:
                case 0xd3:
                    SkipBytes(data, ref pos, 8);
                    return;
                case 0xd4:
                    SkipExt(data, ref pos, 1);
                    return;
                case 0xd5:
                    SkipExt(data, ref pos, 2);
                    return;
                case 0xd6:
                    SkipExt(data, ref pos, 4);
                    return;
                case 0xd7:
                    SkipExt(data, ref pos, 8);
                    return;
                case 0xd8:
                    SkipExt(data, ref pos, 16);
                    return;
                case 0xd9:
                    SkipBytes(data, ref pos, ReadU8(data, ref pos));
                    return;
                case 0xda:
                    SkipBytes(data, ref pos, ReadU16(data, ref pos));
                    return;
                case 0xdb:
                    SkipBytes(data, ref pos, ReadI32Len(data, ref pos));
                    return;
                case 0xdc:
                    SkipArray(data, ref pos, ReadU16(data, ref pos), depth);
                    return;
                case 0xdd:
                    SkipArray(data, ref pos, ReadI32Len(data, ref pos), depth);
                    return;
                case 0xde:
                    SkipMap(data, ref pos, ReadU16(data, ref pos), depth);
                    return;
                case 0xdf:
                    SkipMap(data, ref pos, ReadI32Len(data, ref pos), depth);
                    return;
                default:
                    throw new InvalidDataException("알 수 없는 MessagePack 타입입니다.");
            }
        }

        private static void SkipMap(byte[] data, ref int pos, int count, int depth)
        {
            if (count < 0 || count > 10000000) throw new InvalidDataException("MessagePack 맵 항목 수가 비정상적으로 큽니다.");
            for (int i = 0; i < count; i++)
            {
                MpSkip(data, ref pos, depth + 1);
                MpSkip(data, ref pos, depth + 1);
            }
        }

        private static void SkipArray(byte[] data, ref int pos, int count, int depth)
        {
            if (count < 0 || count > 10000000) throw new InvalidDataException("MessagePack 배열 항목 수가 비정상적으로 큽니다.");
            for (int i = 0; i < count; i++)
                MpSkip(data, ref pos, depth + 1);
        }

        private static void SkipBytes(byte[] data, ref int pos, int count)
        {
            if (count < 0 || pos + count > data.Length)
                throw new InvalidDataException("MessagePack 바이트 데이터가 잘렸습니다.");
            pos += count;
        }

        private static void SkipExt(byte[] data, ref int pos, int count)
        {
            if (pos >= data.Length)
                throw new InvalidDataException("MessagePack 확장 타입이 잘렸습니다.");
            pos++;
            SkipBytes(data, ref pos, count);
        }

        private static int ReadU8(byte[] data, ref int pos)
        {
            if (pos + 1 > data.Length) throw new InvalidDataException("MessagePack uint8이 잘렸습니다.");
            return data[pos++];
        }

        private static int ReadU16(byte[] data, ref int pos)
        {
            if (pos + 2 > data.Length) throw new InvalidDataException("MessagePack uint16이 잘렸습니다.");
            int v = (data[pos] << 8) | data[pos + 1];
            pos += 2;
            return v;
        }

        private static int ReadI32Len(byte[] data, ref int pos)
        {
            if (pos + 4 > data.Length) throw new InvalidDataException("MessagePack uint32 길이가 잘렸습니다.");
            long v = ((long)data[pos] << 24) | ((long)data[pos + 1] << 16) |
                     ((long)data[pos + 2] << 8) | data[pos + 3];
            pos += 4;
            if (v < 0 || v > int.MaxValue) throw new InvalidDataException("MessagePack 길이가 너무 큽니다.");
            return (int)v;
        }

        private static bool IsAsciiLetter(char c)
        {
            return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        }
    }
}
