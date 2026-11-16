using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("하락군협전 세이브 에디터 v1.0")]
[assembly: AssemblyProduct("하락군협전 세이브 에디터 v1.0")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace HoTuLoShuSaveEditor
{
    internal static class Program
    {
        private static string runtimeFolder;

        public static string RuntimeFolder
        {
            get
            {
                return runtimeFolder;
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveWebView2Assembly;

            if (args != null && args.Length >= 2 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                string outDir = args[1];
                string seed = args.Length >= 3 ? args[2] : null;
                runtimeFolder = outDir;
                return SelfTestRunner.Run(outDir, seed);
            }

            runtimeFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "HoTuLoShuSaveEditor",
                "runtime-1.0.0");

            Directory.CreateDirectory(runtimeFolder);
            ExtractRuntimeFile("WebView2Loader.dll", Path.Combine(runtimeFolder, "WebView2Loader.dll"));
            CoreWebView2Environment.SetLoaderDllFolderPath(runtimeFolder);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SaveEditorForm());
            return 0;
        }

        private static Assembly ResolveWebView2Assembly(object sender, ResolveEventArgs args)
        {
            AssemblyName requested = new AssemblyName(args.Name);
            string simpleName = requested.Name;
            if (simpleName == null || simpleName.IndexOf("Microsoft.Web.WebView2", StringComparison.OrdinalIgnoreCase) != 0)
                return null;

            string fileName = simpleName + ".dll";
            string destination = Path.Combine(runtimeFolder, fileName);
            try
            {
                ExtractRuntimeFile(fileName, destination);
                SaveStore.NoLinks(destination);
                using (FileStream fs = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    SaveStore.VerifyHandle(fs, destination);
                }
                return Assembly.LoadFrom(destination);
            }
            catch
            {
                return null;
            }
        }

        internal static void ExtractRuntimeFile(string resourceName, string destination)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            byte[] embedded = ReadResource(asm, resourceName);
            if (embedded == null)
                throw new InvalidOperationException("Missing embedded resource: " + resourceName);

            string dir = Path.GetDirectoryName(destination);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);

            bool write = true;
            if (File.Exists(destination))
            {
                byte[] existing = File.ReadAllBytes(destination);
                if (Sha256(existing) == Sha256(embedded))
                    write = false;
            }

            if (write)
            {
                string temp = destination + ".tmp";
                File.WriteAllBytes(temp, embedded);
                if (File.Exists(destination))
                    File.Delete(destination);
                File.Move(temp, destination);
            }
        }

        internal static byte[] ReadResource(Assembly asm, string resourceName)
        {
            string actual = null;
            string[] names = asm.GetManifestResourceNames();
            for (int i = 0; i < names.Length; i++)
            {
                if (string.Equals(names[i], resourceName, StringComparison.Ordinal)
                    || names[i].EndsWith("." + resourceName, StringComparison.Ordinal))
                {
                    actual = names[i];
                    break;
                }
            }
            if (actual == null)
                return null;
            using (Stream s = asm.GetManifestResourceStream(actual))
            {
                if (s == null)
                    return null;
                using (MemoryStream ms = new MemoryStream())
                {
                    s.CopyTo(ms);
                    return ms.ToArray();
                }
            }
        }

        internal static string Sha256(byte[] data)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(data);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++)
                    sb.Append(hash[i].ToString("x2"));
                return sb.ToString();
            }
        }
    }

    internal sealed class SaveEditorForm : Form
    {
        private WebView2 webView;
        private bool initialNavigationDone;
        private string initialUrl;

        public SaveEditorForm()
        {
            Text = "하락군협전 세이브 에디터 v1.0";
            StartPosition = FormStartPosition.CenterScreen;
            Width = 1180;
            Height = 820;
            MinimumSize = new Size(900, 620);

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            Controls.Add(webView);

            Load += SaveEditorForm_Load;
        }

        private void SaveEditorForm_Load(object sender, EventArgs e)
        {
            InitializeWebViewAsync();
        }

        private async void InitializeWebViewAsync()
        {
            try
            {
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, Program.RuntimeFolder, null);
                await webView.EnsureCoreWebView2Async(env);

                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
                webView.CoreWebView2.NavigationStarting += CoreWebView2_NavigationStarting;

                string html = ReadEmbeddedHtml();
                initialNavigationDone = false;
                webView.NavigateToString(html);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "WebView2 초기화 실패: " + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private void CoreWebView2_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!initialNavigationDone)
            {
                initialNavigationDone = true;
                initialUrl = e.Uri;
                return;
            }

            string target = e.Uri;
            if (!string.IsNullOrEmpty(target)
                && !string.Equals(target, initialUrl, StringComparison.OrdinalIgnoreCase)
                && target.IndexOf("about:blank", StringComparison.OrdinalIgnoreCase) != 0
                && target.IndexOf("data:text/html", StringComparison.OrdinalIgnoreCase) != 0)
            {
                e.Cancel = true;
            }
        }

        internal static string ReadEmbeddedHtml()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            byte[] data = Program.ReadResource(asm, "HoTuLoShuSaveEditor.html");
            if (data == null)
                throw new InvalidOperationException("Missing embedded resource: HoTuLoShuSaveEditor.html");
            return Encoding.UTF8.GetString(data);
        }

        private void CoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json = null;
            try { json = e.TryGetWebMessageAsString(); } catch { }
            if (json == null)
            {
                try { json = e.WebMessageAsJson; } catch { json = null; }
            }

            string response = DispatchWebMessage(this, json, null);
            if (webView != null && webView.CoreWebView2 != null)
                webView.CoreWebView2.PostWebMessageAsString(response);
        }

        internal static string DispatchWebMessage(Form owner, string json, string defaultSavePath)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = Int32.MaxValue;
                Dictionary<string, object> request = ser.Deserialize<Dictionary<string, object>>(json);
                if (request == null)
                    throw new InvalidOperationException("Invalid RPC request.");

                string cmd = GetString(request, "cmd");
                if (string.IsNullOrEmpty(cmd)) cmd = GetString(request, "type");
                string reqId = GetString(request, "id");
                if (cmd == "discover")
                {
                    List<string> paths = SaveStore.DiscoverSavePaths();
                    Dictionary<string, object> ok = new Dictionary<string, object>();
                    ok["ok"] = true;
                    ok["type"] = "discover";
                    if (!string.IsNullOrEmpty(reqId)) ok["id"] = reqId;
                    ok["paths"] = paths;
                    return ser.Serialize(ok);
                }
                if (cmd == "open" || cmd == "load")
                    return HandleOpen(owner, request, reqId, defaultSavePath);
                if (cmd == "save")
                    return HandleSave(request, reqId, defaultSavePath);
                if (cmd == "saveAs")
                    return HandleSaveAs(owner, request, reqId, defaultSavePath);
                return ErrorResponse("알 수 없는 명령입니다: " + cmd, reqId);
            }
            catch (Exception ex)
            {
                return ErrorResponse(ex.Message, null);
            }
        }

        private static string HandleOpen(Form owner, Dictionary<string, object> request, string reqId, string defaultSavePath)
        {
            string path = GetString(request, "path");
            if (string.IsNullOrEmpty(path))
                path = defaultSavePath;
            if (string.IsNullOrEmpty(path))
            {
                if (owner == null)
                    return ErrorResponse("파일을 선택할 창이 없습니다.", reqId);
                using (OpenFileDialog dlg = new OpenFileDialog())
                {
                    dlg.Filter = "하락군협전 세이브 (*.save)|*.save";
                    dlg.CheckFileExists = true;
                    dlg.Multiselect = false;
                    if (dlg.ShowDialog(owner) != DialogResult.OK)
                        return CancelResponse(reqId);
                    path = dlg.FileName;
                }
            }

            path = Path.GetFullPath(path);
            byte[] bytes = SaveStore.Read(path);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = true;
            if (!string.IsNullOrEmpty(reqId)) result["id"] = reqId;
            result["path"] = path;
            result["fileName"] = Path.GetFileName(path);
            result["sha256"] = Program.Sha256(bytes);
            result["dataB64"] = Convert.ToBase64String(bytes);
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(result);
        }

        private static string HandleSave(Dictionary<string, object> request, string reqId, string defaultSavePath)
        {
            string path = GetString(request, "path");
            if (string.IsNullOrEmpty(path))
                path = defaultSavePath;
            string expectedHash = GetString(request, "expectedHash");
            string dataB64 = GetString(request, "dataB64");

            if (string.IsNullOrEmpty(path))
                return ErrorResponse("저장 경로가 없습니다.", reqId);
            if (string.IsNullOrEmpty(dataB64))
                return ErrorResponse("저장 데이터가 없습니다.", reqId);

            path = Path.GetFullPath(path);
            byte[] bytes = Convert.FromBase64String(dataB64);
            string backupPath = SaveStore.SaveWithBackup(path, bytes, expectedHash);
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = true;
            if (!string.IsNullOrEmpty(reqId)) result["id"] = reqId;
            result["path"] = path;
            result["sha256"] = Program.Sha256(bytes);
            result["backupPath"] = backupPath;
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(result);
        }

        private static string HandleSaveAs(Form owner, Dictionary<string, object> request, string reqId, string defaultSavePath)
        {
            string dataB64 = GetString(request, "dataB64");
            if (string.IsNullOrEmpty(dataB64))
                return ErrorResponse("저장 데이터가 없습니다.", reqId);

            string path = GetString(request, "path");
            if (string.IsNullOrEmpty(path))
                path = defaultSavePath;
            if (string.IsNullOrEmpty(path))
            {
                if (owner == null)
                    return ErrorResponse("파일을 선택할 창이 없습니다.", reqId);
                using (SaveFileDialog dlg = new SaveFileDialog())
                {
                    dlg.Filter = "하락군협전 세이브 (*.save)|*.save";
                    dlg.DefaultExt = "save";
                    dlg.AddExtension = true;
                    dlg.OverwritePrompt = true;
                    if (dlg.ShowDialog(owner) != DialogResult.OK)
                        return CancelResponse(reqId);
                    path = dlg.FileName;
                }
            }

            path = Path.GetFullPath(path);
            byte[] bytes = Convert.FromBase64String(dataB64);
            string backupPath = SaveStore.SaveWithBackup(path, bytes, null);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = true;
            if (!string.IsNullOrEmpty(reqId)) result["id"] = reqId;
            result["path"] = path;
            result["sha256"] = Program.Sha256(bytes);
            result["backupPath"] = backupPath;
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(result);
        }

        private static string CancelResponse(string reqId)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = false;
            if (!string.IsNullOrEmpty(reqId)) result["id"] = reqId;
            result["canceled"] = true;
            return new JavaScriptSerializer().Serialize(result);
        }

        private static string ErrorResponse(string message, string reqId)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = false;
            if (!string.IsNullOrEmpty(reqId)) result["id"] = reqId;
            result["error"] = message;
            return new JavaScriptSerializer().Serialize(result);
        }

        internal static string GetString(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj != null && obj.TryGetValue(key, out value) && value != null)
                return Convert.ToString(value);
            return null;
        }
    }

    internal static class SelfTestRunner
    {
        public static int Run(string outDir, string seedSavePath)
        {
            try
            {
                if (string.IsNullOrEmpty(outDir))
                    throw new ArgumentException("outDir is required.");
                outDir = Path.GetFullPath(outDir);
                if (Directory.Exists(outDir) || File.Exists(outDir))
                    throw new InvalidOperationException("outDir already exists: " + outDir);

                Directory.CreateDirectory(outDir);
                Directory.CreateDirectory(Path.Combine(outDir, "work"));

                string workSave = Path.Combine(outDir, "work", "test.save");
                SaveStore.NoLinks(workSave);
                bool seedUsed = false;
                if (!string.IsNullOrEmpty(seedSavePath))
                {
                    string seedFull = Path.GetFullPath(seedSavePath);
                    byte[] seedBytes = SaveStore.Read(seedFull);
                    File.WriteAllBytes(workSave, seedBytes);
                    seedUsed = true;
                }

                return RunWebViewSelfTest(outDir, workSave, seedUsed);
            }
            catch (Exception ex)
            {
                try
                {
                    if (!string.IsNullOrEmpty(outDir))
                    {
                        if (!Directory.Exists(outDir))
                            Directory.CreateDirectory(outDir);
                        Dictionary<string, object> error = new Dictionary<string, object>();
                        error["ok"] = false;
                        error["error"] = ex.ToString();
                        string json = new JavaScriptSerializer().Serialize(error);
                        File.WriteAllText(Path.Combine(outDir, "receipt.json"), json, new UTF8Encoding(false));
                    }
                }
                catch
                {
                }
                return 1;
            }
        }

        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        private static int RunWebViewSelfTest(string outDir, string workSave, bool seedUsed)
        {
            Program.ExtractRuntimeFile("WebView2Loader.dll", Path.Combine(outDir, "WebView2Loader.dll"));
            CoreWebView2Environment.SetLoaderDllFolderPath(outDir);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (SelfTestForm form = new SelfTestForm(outDir, workSave, seedUsed))
            {
                Application.Run(form);
                return form.ExitCode;
            }
        }
    }

    internal sealed class SelfTestForm : Form
    {
        private readonly string outDir;
        private readonly string workSave;
        private readonly bool seedUsed;
        private WebView2 webView;
        private TaskCompletionSource<Dictionary<string, object>> selfTestTcs;
        private int exitCode;
        private bool started;
        private bool initialNavigationDone;
        private string receiptPath;

        public int ExitCode
        {
            get { return exitCode; }
        }

        public SelfTestForm(string outDir, string workSave, bool seedUsed)
        {
            this.outDir = outDir;
            this.workSave = workSave;
            this.seedUsed = seedUsed;
            this.exitCode = 1;
            this.receiptPath = Path.Combine(outDir, "receipt.json");

            Text = "하락군협전 세이브 에디터 v1.0";
            WindowState = FormWindowState.Minimized;
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.Sizable;
            Width = 900;
            Height = 600;

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            Controls.Add(webView);

            Load += SelfTestForm_Load;
        }

        private void SelfTestForm_Load(object sender, EventArgs e)
        {
            InitializeAsync();
        }

        private async void InitializeAsync()
        {
            try
            {
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, outDir, null);
                await webView.EnsureCoreWebView2Async(env);

                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
                webView.CoreWebView2.NavigationStarting += CoreWebView2_NavigationStarting;
                webView.CoreWebView2.NavigationCompleted += CoreWebView2_NavigationCompleted;

                initialNavigationDone = false;
                webView.NavigateToString(SaveEditorForm.ReadEmbeddedHtml());
            }
            catch (Exception ex)
            {
                WriteFailure(ex);
            }
        }

        private void CoreWebView2_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!initialNavigationDone)
            {
                initialNavigationDone = true;
                return;
            }
            if (e.Uri != null
                && e.Uri.IndexOf("about:blank", StringComparison.OrdinalIgnoreCase) != 0
                && e.Uri.IndexOf("data:text/html", StringComparison.OrdinalIgnoreCase) != 0)
            {
                e.Cancel = true;
            }
        }

        private async void CoreWebView2_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (started)
                return;
            started = true;

            if (!e.IsSuccess)
            {
                WriteFailure(new InvalidOperationException("Navigation failed: " + e.WebErrorStatus));
                return;
            }

            try
            {
                await RunTestScriptAsync();
            }
            catch (Exception ex)
            {
                WriteFailure(ex);
            }
        }

        private async Task RunTestScriptAsync()
        {
            byte[] htmlBytes = Program.ReadResource(Assembly.GetExecutingAssembly(), "HoTuLoShuSaveEditor.html");
            string htmlHash = Program.Sha256(htmlBytes);
            selfTestTcs = new TaskCompletionSource<Dictionary<string, object>>();

            string js = @"
(async function () {
  function b64ToBytes(b64) {
    var bin = atob(b64 || '');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var bin = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(bin);
  }
  function rpc(msg) {
    return new Promise(function (resolve, reject) {
      var id = 'st_' + Date.now() + '_' + Math.random();
      function handler(ev) {
        var d = ev.data;
        if (typeof d === 'string') {
          try { d = JSON.parse(d); } catch (e) { return; }
        }
        if (!d || d.id !== id) return;
        window.chrome.webview.removeEventListener('message', handler);
        if (d.ok) resolve(d);
        else reject(new Error(d.error || 'RPC failed'));
      }
      window.chrome.webview.addEventListener('message', handler);
      msg.id = id;
      window.chrome.webview.postMessage(JSON.stringify(msg));
    });
  }

  if (!window.HtlsEditorCore) throw new Error('HtlsEditorCore missing');
  var workPath = window.__HTLS_SELF_TEST_PATH__;
  if (!window.__HTLS_SEED_USED__) {
    var demo = window.HtlsEditorCore.createDemoSave();
    await rpc({ cmd: 'saveAs', path: workPath, dataB64: bytesToB64(demo) });
  }

  var opened = await rpc({ cmd: 'open', path: workPath });
  var u8 = b64ToBytes(opened.dataB64);
  var sess = window.HtlsEditorCore.createSession(u8, 'test.save');
  var v1 = sess.validate();
  if (!v1 || !v1.ok) throw new Error('Initial validation failed: ' + JSON.stringify(v1));

  window.HtlsEditorCore.applyPreset(sess, 'rich_hero');
  var outBytes = sess.syncHeaderAndSave();
  var saved = await rpc({ cmd: 'save', path: workPath, expectedHash: opened.sha256, dataB64: bytesToB64(outBytes) });

  var reloaded = await rpc({ cmd: 'open', path: workPath });
  var rb = b64ToBytes(reloaded.dataB64);
  var sess2 = window.HtlsEditorCore.createSession(rb, 'test.save');
  var v2 = sess2.validate();
  if (!v2 || !v2.ok) throw new Error('Reparse validation failed: ' + JSON.stringify(v2));

  var detail = sess2.getCharacterDetail('Player');
  var stats = detail && detail.stats ? detail.stats : [];
  var money = null;
  for (var i = 0; i < stats.length; i++) {
    if (stats[i] && stats[i].key === 'Money') {
      money = stats[i].value;
      break;
    }
  }
  if (money !== 999999999) throw new Error('Money mismatch: ' + money);

  var bodyText = document.body ? (document.body.innerText || '') : '';
  if (bodyText.indexOf('[object Object]') >= 0) throw new Error('Found [object Object] in body');
  if (/[\u4E00-\u9FFF]/.test(bodyText)) throw new Error('Found CJK characters in body');

  return { ok: true, path: saved.path, sha256: saved.sha256, backupPath: saved.backupPath, reparsedMoney: money };
})().then(function (r) {
  window.chrome.webview.postMessage(JSON.stringify({ cmd: '__selftest_done__', result: r }));
}).catch(function (e) {
  window.chrome.webview.postMessage(JSON.stringify({ cmd: '__selftest_done__', result: { ok: false, error: String(e && e.stack ? e.stack : e) } }));
});
";

            string script = "window.__HTLS_SELF_TEST_PATH__ = " + ToJavaScriptString(workSave) + ";\r\n"
                + "window.__HTLS_SEED_USED__ = " + (seedUsed ? "true" : "false") + ";\r\n" + js;
            await webView.CoreWebView2.ExecuteScriptAsync(script);

            Task completed = await Task.WhenAny(selfTestTcs.Task, Task.Delay(45000));
            if (completed != selfTestTcs.Task)
                throw new TimeoutException("Self-test timed out.");

            Dictionary<string, object> result = await selfTestTcs.Task;
            if (result == null)
                throw new InvalidOperationException("Self-test returned no result.");

            bool ok = GetBool(result, "ok");
            if (!ok)
            {
                string err = GetString(result, "error");
                throw new InvalidOperationException(err == null ? "Self-test failed." : err);
            }

            string backupPath = GetString(result, "backupPath");
            bool backupCreated = !string.IsNullOrEmpty(backupPath) && File.Exists(backupPath);
            if (!backupCreated)
                throw new InvalidOperationException("Backup was not created.");

            long reparsedMoney = GetLong(result, "reparsedMoney");
            if (reparsedMoney != 999999999L)
                throw new InvalidOperationException("Reparsed money mismatch.");

            byte[] finalBytes = SaveStore.Read(workSave);

            Dictionary<string, object> receipt = new Dictionary<string, object>();
            receipt["ok"] = true;
            receipt["htmlHash"] = htmlHash;
            receipt["seedUsed"] = seedUsed;
            receipt["backupCreated"] = backupCreated;
            receipt["backupPath"] = backupPath;
            receipt["reparsedMoney"] = reparsedMoney;
            Dictionary<string, object> checks = new Dictionary<string, object>();
            checks["validateSaveBytes"] = true;
            checks["backupExists"] = backupCreated;
            checks["money"] = reparsedMoney == 999999999L;
            checks["sha256"] = Program.Sha256(finalBytes);
            receipt["checks"] = checks;

            string receiptJson = new JavaScriptSerializer().Serialize(receipt);
            File.WriteAllText(receiptPath, receiptJson, new UTF8Encoding(false));
            exitCode = 0;
            Close();
        }

        private void CoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json = null;
            try { json = e.TryGetWebMessageAsString(); } catch { }
            if (json == null)
            {
                try { json = e.WebMessageAsJson; } catch { json = null; }
            }

            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = Int32.MaxValue;
            Dictionary<string, object> req = null;
            try
            {
                if (!string.IsNullOrEmpty(json))
                    req = ser.Deserialize<Dictionary<string, object>>(json);
            }
            catch
            {
                req = null;
            }

            string cmd = SaveEditorForm.GetString(req, "cmd");
            if (string.Equals(cmd, "__selftest_done__", StringComparison.Ordinal))
            {
                Dictionary<string, object> resDict = null;
                object resObj;
                if (req != null && req.TryGetValue("result", out resObj))
                    resDict = resObj as Dictionary<string, object>;
                if (resDict == null)
                {
                    resDict = new Dictionary<string, object>();
                    resDict["ok"] = false;
                    resDict["error"] = "Missing self-test result payload.";
                }
                if (selfTestTcs != null)
                    selfTestTcs.TrySetResult(resDict);
                return;
            }

            string response = SaveEditorForm.DispatchWebMessage(this, json, workSave);
            if (webView != null && webView.CoreWebView2 != null)
                webView.CoreWebView2.PostWebMessageAsString(response);
        }

        private void WriteFailure(Exception ex)
        {
            try
            {
                Dictionary<string, object> receipt = new Dictionary<string, object>();
                receipt["ok"] = false;
                receipt["error"] = ex.ToString();
                string json = new JavaScriptSerializer().Serialize(receipt);
                File.WriteAllText(receiptPath, json, new UTF8Encoding(false));
            }
            catch
            {
            }
            exitCode = 1;
            Close();
        }

        private static string ToJavaScriptString(string value)
        {
            if (value == null)
                return "null";
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32)
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static string GetString(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj != null && obj.TryGetValue(key, out value) && value != null)
                return Convert.ToString(value);
            return null;
        }

        private static bool GetBool(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj != null && obj.TryGetValue(key, out value) && value != null)
                return Convert.ToBoolean(value);
            return false;
        }

        private static long GetLong(Dictionary<string, object> obj, string key)
        {
            object value;
            if (obj != null && obj.TryGetValue(key, out value) && value != null)
                return Convert.ToInt64(value);
            return 0L;
        }
    }
}
