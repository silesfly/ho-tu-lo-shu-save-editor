using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using HoTuLoShuSaveEditor;

namespace HoTuLoShuSaveEditor.Tests
{
    internal static class SaveStoreTests
    {
        private delegate void TestAction();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLinkW(
            string lpFileName,
            string lpExistingFileName,
            IntPtr lpSecurityAttributes);

        private static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

        public static int Main(string[] args)
        {
            string tempDir = Path.Combine(
                Path.GetTempPath(),
                "HTLS_SaveStoreTests_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);

            int passed = 0;
            int failed = 0;

            try
            {
                RunTest("1. BuildMinimalValidSaveBytes passes ValidateSaveBytes", delegate
                {
                    if (SaveStore.MaxSaveBytes != 32L * 1024L * 1024L)
                    {
                        throw new Exception("Unexpected MaxSaveBytes.");
                    }
                    if (SaveStore.MaxUncompressedSaveBytes != 96L * 1024L * 1024L)
                    {
                        throw new Exception("Unexpected MaxUncompressedSaveBytes.");
                    }

                    byte[] valid = BuildMinimalValidSaveBytes(12345);
                    SaveStore.ValidateSaveBytes(valid);
                }, ref passed, ref failed);

                RunTest("2. Corrupt magic, truncated frame, bad LZ4 length, zeroed bytes throw", delegate
                {
                    byte[] valid = BuildMinimalValidSaveBytes(12345);

                    byte[] badMagic = (byte[])valid.Clone();
                    badMagic[0] = (byte)'X';
                    AssertThrows(typeof(InvalidDataException), delegate
                    {
                        SaveStore.ValidateSaveBytes(badMagic);
                    }, "corrupt magic");

                    byte[] truncated = new byte[15];
                    Buffer.BlockCopy(valid, 0, truncated, 0, truncated.Length);
                    AssertThrows(typeof(InvalidDataException), delegate
                    {
                        SaveStore.ValidateSaveBytes(truncated);
                    }, "truncated frame");

                    byte[] badLz4Mismatch = (byte[])valid.Clone();
                    badLz4Mismatch[19] = (byte)(badLz4Mismatch[19] + 5);
                    AssertThrows(typeof(InvalidDataException), delegate
                    {
                        SaveStore.ValidateSaveBytes(badLz4Mismatch);
                    }, "bad LZ4 mismatched length");

                    byte[] badLz4Huge = (byte[])valid.Clone();
                    badLz4Huge[16] = 0x7F;
                    badLz4Huge[17] = 0xFF;
                    badLz4Huge[18] = 0xFF;
                    badLz4Huge[19] = 0xFF;
                    AssertThrows(typeof(InvalidDataException), delegate
                    {
                        SaveStore.ValidateSaveBytes(badLz4Huge);
                    }, "bad LZ4 oversized length");

                    byte[] zeroed = new byte[128];
                    AssertThrows(typeof(InvalidDataException), delegate
                    {
                        SaveStore.ValidateSaveBytes(zeroed);
                    }, "zeroed bytes");
                }, ref passed, ref failed);

                RunTest("3. HasInvalidColon", delegate
                {
                    AssertEqual(false, SaveStore.HasInvalidColon("C:\\temp\\a.save"), "normal drive path");
                    AssertEqual(true, SaveStore.HasInvalidColon("C:\\temp\\a.save:zone"), "ADS colon");
                    AssertEqual(true, SaveStore.HasInvalidColon("\\\\?\\C:\\a.save"), "extended prefix colon");
                }, ref passed, ref failed);

                RunTest("4. IsReservedDeviceName", delegate
                {
                    AssertEqual(true, SaveStore.IsReservedDeviceName("CON"), "CON");
                    AssertEqual(true, SaveStore.IsReservedDeviceName("nul"), "nul");
                    AssertEqual(true, SaveStore.IsReservedDeviceName("LPT1"), "LPT1");
                    AssertEqual(true, SaveStore.IsReservedDeviceName("COM9"), "COM9");
                    AssertEqual(false, SaveStore.IsReservedDeviceName("Manual001"), "Manual001");
                }, ref passed, ref failed);

                RunTest("5. IsSaveExtension", delegate
                {
                    AssertEqual(true, SaveStore.IsSaveExtension("a.save"), "a.save");
                    AssertEqual(true, SaveStore.IsSaveExtension("a.SAVE"), "a.SAVE");
                    AssertEqual(false, SaveStore.IsSaveExtension("a.txt"), "a.txt");
                    AssertEqual(false, SaveStore.IsSaveExtension("a.save.bak"), "a.save.bak");
                }, ref passed, ref failed);

                RunTest("6. Reserved device, ADS, and UNC paths throw on SaveWithBackup/NoLinks/Read", delegate
                {
                    byte[] sample = BuildMinimalValidSaveBytes(1);
                    string[] badPaths = new string[]
                    {
                        Path.Combine(tempDir, "CON.save"),
                        Path.Combine(tempDir, "evil.save:stream"),
                        @"\\127.0.0.1\c$\test.save"
                    };

                    for (int i = 0; i < badPaths.Length; i++)
                    {
                        string badPath = badPaths[i];
                        AssertThrows(typeof(Exception), delegate
                        {
                            SaveStore.NoLinks(badPath);
                        }, "NoLinks on " + badPath);

                        AssertThrows(typeof(Exception), delegate
                        {
                            SaveStore.Read(badPath);
                        }, "Read on " + badPath);

                        AssertThrows(typeof(Exception), delegate
                        {
                            SaveStore.SaveWithBackup(badPath, sample, null);
                        }, "SaveWithBackup on " + badPath);
                    }
                }, ref passed, ref failed);

                RunTest("7. NTFS hardlink throws on Read and SaveWithBackup", delegate
                {
                    string origPath = Path.Combine(tempDir, "orig_hardlink.save");
                    string linkPath = Path.Combine(tempDir, "linked_hardlink.save");
                    byte[] v1 = BuildMinimalValidSaveBytes(111);
                    byte[] v2 = BuildMinimalValidSaveBytes(222);

                    string firstBak = SaveStore.SaveWithBackup(origPath, v1, null);
                    if (firstBak != null)
                    {
                        throw new Exception("Expected null backup for new file.");
                    }

                    if (!CreateHardLinkW(linkPath, origPath, IntPtr.Zero))
                    {
                        int err = Marshal.GetLastWin32Error();
                        throw new Exception(string.Format("CreateHardLinkW failed with Win32 error {0}.", err));
                    }

                    using (FileStream hfs = new FileStream(linkPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        AssertThrows(typeof(Exception), delegate
                        {
                            SaveStore.VerifyHandle(hfs, Path.GetFullPath(linkPath));
                        }, "VerifyHandle on hardlink");
                    }

                    AssertThrows(typeof(Exception), delegate
                    {
                        SaveStore.Read(linkPath);
                    }, "Read on hardlink");

                    string h1 = SaveStore.Hash(v1);
                    AssertThrows(typeof(Exception), delegate
                    {
                        SaveStore.SaveWithBackup(linkPath, v2, h1);
                    }, "SaveWithBackup on hardlink");
                }, ref passed, ref failed);

                RunTest("8. NTFS directory junction throws on NoLinks", delegate
                {
                    string realDir = Path.Combine(tempDir, "real_target_dir");
                    string junctionDir = Path.Combine(tempDir, "junction_dir");
                    Directory.CreateDirectory(realDir);

                    string realSave = Path.Combine(realDir, "jtest.save");
                    byte[] v1 = BuildMinimalValidSaveBytes(333);
                    SaveStore.SaveWithBackup(realSave, v1, null);

                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "cmd.exe";
                    psi.Arguments = string.Format("/c mklink /J \"{0}\" \"{1}\"", junctionDir, realDir);
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;

                    try
                    {
                        using (Process proc = Process.Start(psi))
                        {
                            string stdout = proc.StandardOutput.ReadToEnd();
                            string stderr = proc.StandardError.ReadToEnd();
                            proc.WaitForExit();
                            if (proc.ExitCode != 0)
                            {
                                throw new Exception(string.Format(
                                    "mklink /J failed (exit {0}): {1} {2}",
                                    proc.ExitCode, stdout, stderr));
                            }
                        }

                        string throughJunction = Path.Combine(junctionDir, "jtest.save");
                        AssertThrows(typeof(Exception), delegate
                        {
                            SaveStore.NoLinks(throughJunction);
                        }, "NoLinks through junction");
                    }
                    finally
                    {
                        if (Directory.Exists(junctionDir))
                        {
                            Directory.Delete(junctionDir, false);
                        }
                    }
                }, ref passed, ref failed);

                RunTest("9. HTLS_SIMULATE_GAME_RUNNING=1 makes IsGameRunning true and blocks SaveWithBackup", delegate
                {
                    string prev = Environment.GetEnvironmentVariable("HTLS_SIMULATE_GAME_RUNNING");
                    string targetPath = Path.Combine(tempDir, "sim_running.save");
                    byte[] v1 = BuildMinimalValidSaveBytes(444);

                    try
                    {
                        Environment.SetEnvironmentVariable("HTLS_SIMULATE_GAME_RUNNING", "1");
                        AssertEqual(true, SaveStore.IsGameRunning(), "IsGameRunning when simulated");

                        AssertThrows(typeof(Exception), delegate
                        {
                            SaveStore.SaveWithBackup(targetPath, v1, null);
                        }, "SaveWithBackup while game simulated running");
                    }
                    finally
                    {
                        Environment.SetEnvironmentVariable("HTLS_SIMULATE_GAME_RUNNING", prev);
                    }
                }, ref passed, ref failed);

                RunTest("10. SaveWithBackup end-to-end and VerifyHandle", delegate
                {
                    string e2eDir = Path.Combine(tempDir, "e2e");
                    Directory.CreateDirectory(e2eDir);
                    string targetPath = Path.Combine(e2eDir, "Manual001.save");
                    string otherPath = Path.Combine(e2eDir, "Other.save");

                    byte[] v1 = BuildMinimalValidSaveBytes(1000);
                    byte[] v2 = BuildMinimalValidSaveBytes(2500);
                    string h1 = SaveStore.Hash(v1);

                    string bak1 = SaveStore.SaveWithBackup(targetPath, v1, null);
                    if (bak1 != null)
                    {
                        throw new Exception("Expected null backup path on initial save.");
                    }
                    AssertBytesEqual(v1, SaveStore.Read(targetPath), "target equals v1");

                    using (FileStream fs = new FileStream(targetPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        SaveStore.VerifyHandle(fs, Path.GetFullPath(targetPath));
                        AssertThrows(typeof(Exception), delegate
                        {
                            SaveStore.VerifyHandle(fs, Path.GetFullPath(otherPath));
                        }, "VerifyHandle mismatched path");
                    }

                    string bak2 = SaveStore.SaveWithBackup(targetPath, v2, h1);
                    if (string.IsNullOrEmpty(bak2) || !File.Exists(bak2))
                    {
                        throw new Exception("Expected backup file to be created on overwrite.");
                    }
                    if (!bak2.StartsWith(targetPath + ".", StringComparison.OrdinalIgnoreCase) ||
                        !bak2.EndsWith(".bak", StringComparison.OrdinalIgnoreCase))
                    {
                        throw new Exception("Unexpected backup filename format: " + bak2);
                    }

                    string bakHash = SaveStore.Hash(File.ReadAllBytes(bak2));
                    AssertEqual(h1, bakHash, "backup SHA-256 matches v1");
                    AssertBytesEqual(v2, SaveStore.Read(targetPath), "target equals v2");

                    string[] baksBefore = Directory.GetFiles(e2eDir, "*.bak");
                    AssertThrows(typeof(Exception), delegate
                    {
                        SaveStore.SaveWithBackup(targetPath, v1, h1);
                    }, "stale expectedOrigSha256OrNull throws");

                    string[] baksAfter = Directory.GetFiles(e2eDir, "*.bak");
                    AssertEqual(baksBefore.Length, baksAfter.Length, "no new .bak on stale hash");
                    AssertBytesEqual(v2, SaveStore.Read(targetPath), "target unchanged after stale hash");
                }, ref passed, ref failed);

                RunTest("12. Pre-existing .lock hardlink throws without modifying or deleting victim", delegate
                {
                    string lockTestDir = Path.Combine(tempDir, "lock_guard");
                    Directory.CreateDirectory(lockTestDir);
                    string victimPath = Path.Combine(lockTestDir, "victim.save");
                    string guardedTarget = Path.Combine(lockTestDir, "guarded.save");
                    string plantedLock = guardedTarget + ".lock";

                    byte[] v1 = BuildMinimalValidSaveBytes(777);
                    byte[] v2 = BuildMinimalValidSaveBytes(888);
                    File.WriteAllBytes(victimPath, v1);

                    if (!CreateHardLinkW(plantedLock, victimPath, IntPtr.Zero))
                    {
                        throw new Exception("CreateHardLinkW failed for lock guard test: " + Marshal.GetLastWin32Error());
                    }

                    AssertThrows(typeof(Exception), delegate
                    {
                        SaveStore.SaveWithBackup(guardedTarget, v2, null);
                    }, "SaveWithBackup with pre-existing .lock hardlink");

                    AssertEqual(true, File.Exists(plantedLock), "pre-existing .lock must remain intact");
                    AssertBytesEqual(v1, File.ReadAllBytes(victimPath), "victim file must remain untouched");
                    AssertEqual(false, File.Exists(guardedTarget), "guardedTarget must not be created");
                }, ref passed, ref failed);

                if (args != null && args.Length > 0 && !string.IsNullOrEmpty(args[0]))
                {
                    string realPath = args[0];
                    RunTest("11. Real save read: " + realPath, delegate
                    {
                        byte[] realBytes = SaveStore.Read(realPath);
                        if (realBytes == null || realBytes.Length == 0)
                        {
                            throw new Exception("Read returned empty bytes.");
                        }
                        SaveStore.ValidateSaveBytes(realBytes);
                        Console.WriteLine(string.Format(
                            "    Read {0} bytes, SHA-256={1}",
                            realBytes.Length,
                            SaveStore.Hash(realBytes)));
                    }, ref passed, ref failed);
                }
            }
            finally
            {
                try
                {
                    if (Directory.Exists(tempDir))
                    {
                        Directory.Delete(tempDir, true);
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("Cleanup warning: " + ex.Message);
                }
            }

            Console.WriteLine(string.Format("Summary: {0} passed, {1} failed.", passed, failed));
            return failed == 0 ? 0 : 1;
        }

        private static byte[] BuildMinimalValidSaveBytes(int money)
        {
            byte[] headerMsgPack = BuildHeaderMsgPack();
            byte[] headerFrame = WrapLz4Ext32(headerMsgPack);

            byte[] gameDataMsgPack = BuildGameDataMsgPack(money);
            byte[] gameDataFrame = WrapLz4Ext32(gameDataMsgPack);

            byte[] magic = Encoding.ASCII.GetBytes("HELUO_1_1");
            byte[] result = new byte[magic.Length + headerFrame.Length + gameDataFrame.Length];
            int offset = 0;
            Buffer.BlockCopy(magic, 0, result, offset, magic.Length);
            offset += magic.Length;
            Buffer.BlockCopy(headerFrame, 0, result, offset, headerFrame.Length);
            offset += headerFrame.Length;
            Buffer.BlockCopy(gameDataFrame, 0, result, offset, gameDataFrame.Length);
            return result;
        }

        private static byte[] BuildHeaderMsgPack()
        {
            using (MemoryStream ms = new MemoryStream())
            {
                ms.WriteByte(0x84);

                WriteMsgPackString(ms, "saveTime");
                ms.WriteByte(0xd3);
                WriteInt64BE(ms, 638000000000000000L);

                WriteMsgPackString(ms, "playedTime");
                ms.WriteByte(0xd3);
                WriteInt64BE(ms, 3600L);

                WriteMsgPackString(ms, "playerName");
                WriteMsgPackString(ms, "\uBB34\uBA85");

                WriteMsgPackString(ms, "playerLevel");
                ms.WriteByte(0x01);

                return ms.ToArray();
            }
        }

        private static byte[] BuildGameDataMsgPack(int money)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                ms.WriteByte(0x84);

                WriteMsgPackString(ms, "Character");
                ms.WriteByte(0x81);
                WriteMsgPackString(ms, "Player");
                ms.WriteByte(0x81);
                WriteMsgPackString(ms, "Data");
                ms.WriteByte(0x81);
                WriteMsgPackString(ms, "Money");
                ms.WriteByte(0x81);
                WriteMsgPackString(ms, "Base");
                WriteMsgPackInt32(ms, money);

                WriteMsgPackString(ms, "Teammates");
                ms.WriteByte(0x90);

                WriteMsgPackString(ms, "DaysFromBeginning");
                ms.WriteByte(0x01);

                WriteMsgPackString(ms, "inventoryNoList");
                ms.WriteByte(0x90);

                return ms.ToArray();
            }
        }

        private static byte[] WrapLz4Ext32(byte[] rawBytes)
        {
            byte[] lz4Block = EncodeLz4LiteralOnlyBlock(rawBytes);
            uint payloadLen = checked((uint)(1 + 4 + lz4Block.Length));

            using (MemoryStream ms = new MemoryStream())
            {
                ms.WriteByte(0xc9);
                WriteUInt32BE(ms, payloadLen);
                ms.WriteByte(99);
                ms.WriteByte(0xd2);
                WriteInt32BE(ms, rawBytes.Length);
                ms.Write(lz4Block, 0, lz4Block.Length);
                return ms.ToArray();
            }
        }

        private static byte[] EncodeLz4LiteralOnlyBlock(byte[] rawBytes)
        {
            int len = rawBytes.Length;
            using (MemoryStream ms = new MemoryStream())
            {
                if (len < 15)
                {
                    ms.WriteByte((byte)(len << 4));
                }
                else
                {
                    ms.WriteByte((byte)(15 << 4));
                    int rem = len - 15;
                    while (rem >= 255)
                    {
                        ms.WriteByte(255);
                        rem -= 255;
                    }
                    ms.WriteByte((byte)rem);
                }

                ms.Write(rawBytes, 0, len);
                return ms.ToArray();
            }
        }

        private static void WriteMsgPackString(Stream ms, string s)
        {
            byte[] utf8 = Utf8NoBom.GetBytes(s);
            if (utf8.Length <= 31)
            {
                ms.WriteByte((byte)(0xa0 | utf8.Length));
            }
            else if (utf8.Length <= 255)
            {
                ms.WriteByte(0xd9);
                ms.WriteByte((byte)utf8.Length);
            }
            else
            {
                ms.WriteByte(0xda);
                ms.WriteByte((byte)(utf8.Length >> 8));
                ms.WriteByte((byte)(utf8.Length & 0xFF));
            }
            ms.Write(utf8, 0, utf8.Length);
        }

        private static void WriteMsgPackInt32(Stream ms, int value)
        {
            if (value >= 0 && value <= 127)
            {
                ms.WriteByte((byte)value);
            }
            else
            {
                ms.WriteByte(0xd2);
                WriteInt32BE(ms, value);
            }
        }

        private static void WriteUInt32BE(Stream ms, uint value)
        {
            ms.WriteByte((byte)(value >> 24));
            ms.WriteByte((byte)(value >> 16));
            ms.WriteByte((byte)(value >> 8));
            ms.WriteByte((byte)(value & 0xFF));
        }

        private static void WriteInt32BE(Stream ms, int value)
        {
            WriteUInt32BE(ms, unchecked((uint)value));
        }

        private static void WriteInt64BE(Stream ms, long value)
        {
            ulong u = unchecked((ulong)value);
            ms.WriteByte((byte)(u >> 56));
            ms.WriteByte((byte)(u >> 48));
            ms.WriteByte((byte)(u >> 40));
            ms.WriteByte((byte)(u >> 32));
            ms.WriteByte((byte)(u >> 24));
            ms.WriteByte((byte)(u >> 16));
            ms.WriteByte((byte)(u >> 8));
            ms.WriteByte((byte)(u & 0xFF));
        }

        private static void RunTest(string name, TestAction action, ref int passed, ref int failed)
        {
            try
            {
                action();
                passed++;
                Console.WriteLine("[PASS] " + name);
            }
            catch (Exception ex)
            {
                failed++;
                Console.Error.WriteLine("[FAIL] " + name + ": " + ex.GetType().Name + " - " + ex.Message);
            }
        }

        private static void AssertThrows(Type expectedExceptionType, TestAction action, string context)
        {
            try
            {
                action();
            }
            catch (Exception ex)
            {
                if (expectedExceptionType.IsInstanceOfType(ex))
                {
                    return;
                }
                throw new Exception(string.Format(
                    "Expected {0} for {1}, got {2}: {3}",
                    expectedExceptionType.Name,
                    context,
                    ex.GetType().Name,
                    ex.Message));
            }
            throw new Exception(string.Format("Expected {0} to be thrown for {1}, but no exception occurred.", expectedExceptionType.Name, context));
        }

        private static void AssertEqual(bool expected, bool actual, string context)
        {
            if (expected != actual)
            {
                throw new Exception(string.Format("Assertion failed ({0}): expected {1}, got {2}.", context, expected, actual));
            }
        }

        private static void AssertEqual(int expected, int actual, string context)
        {
            if (expected != actual)
            {
                throw new Exception(string.Format("Assertion failed ({0}): expected {1}, got {2}.", context, expected, actual));
            }
        }

        private static void AssertEqual(string expected, string actual, string context)
        {
            if (!string.Equals(expected, actual, StringComparison.Ordinal))
            {
                throw new Exception(string.Format("Assertion failed ({0}): expected '{1}', got '{2}'.", context, expected, actual));
            }
        }

        private static void AssertBytesEqual(byte[] expected, byte[] actual, string context)
        {
            if (expected == null || actual == null || expected.Length != actual.Length)
            {
                throw new Exception(string.Format(
                    "Byte array length mismatch ({0}): expected {1}, got {2}.",
                    context,
                    expected == null ? -1 : expected.Length,
                    actual == null ? -1 : actual.Length));
            }
            for (int i = 0; i < expected.Length; i++)
            {
                if (expected[i] != actual[i])
                {
                    throw new Exception(string.Format("Byte mismatch ({0}) at index {1}.", context, i));
                }
            }
        }
    }
}
