using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace GeaDiagnostics {
    internal sealed class CollectionResult {
        public string Archive;
        public bool Partial;
        public string Summary;
        public object[] Coverage;
    }
    internal sealed class OwnedJob : IDisposable {
        IntPtr handle;
        [StructLayout(LayoutKind.Sequential)] struct Basic { public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
        [StructLayout(LayoutKind.Sequential)] struct Io { public ulong read, write, other, readBytes, writeBytes, otherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic basic; public Io io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
        internal OwnedJob() {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new IOException("PROCESS_JOB_UNAVAILABLE");
            var limits = new Limits(); limits.basic.flags = 0x2000;
            IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(limits));
            try { Marshal.StructureToPtr(limits, data, false); if (!SetInformationJobObject(handle, 9, data, (uint)Marshal.SizeOf(limits))) { Dispose(); throw new IOException("PROCESS_JOB_SETUP_FAILED"); } }
            finally { Marshal.FreeHGlobal(data); }
        }
        internal void Add(Process process) { if (!AssignProcessToJobObject(handle, process.Handle)) { process.Kill(); throw new IOException("PROCESS_JOB_ASSIGN_FAILED"); } }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
    internal static class Collection {
        internal static string Digest(string path) { using (var stream = File.OpenRead(path)) using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
        internal static string Engine() {
            string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GEA Diagnostics", "engine", BuildInfo.EngineHash);
            Directory.CreateDirectory(directory);
            for (var parent = new DirectoryInfo(directory); parent != null; parent = parent.Parent) if ((parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("ENGINE_LINKED_DIRECTORY");
            string path = Path.Combine(directory, "support-bundle.exe");
            if (!File.Exists(path)) {
                string temporary = path + "." + Guid.NewGuid().ToString("N") + ".partial";
                try {
                    using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Troubleshoot.Engine")) using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) source.CopyTo(output);
                    if (Digest(temporary) != BuildInfo.EngineHash) throw new IOException("ENGINE_INTEGRITY_FAILED");
                    try { File.Move(temporary, path); } catch (IOException) { if (!File.Exists(path) || Digest(path) != BuildInfo.EngineHash) throw; }
                } finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 || Digest(path) != BuildInfo.EngineHash) throw new IOException("ENGINE_INTEGRITY_FAILED");
            return path;
        }
        internal static CollectionPlan Create(string acceptance) {
            string run = acceptance ?? Path.Combine(Path.GetTempPath(), "GEA-Diagnostics-" + Guid.NewGuid().ToString("N"));
            if (acceptance != null) {
                string allowed = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!Path.GetFullPath(run).StartsWith(allowed, StringComparison.OrdinalIgnoreCase) || Directory.Exists(run)) throw new IOException("ACCEPTANCE_DIRECTORY_INVALID");
            }
            Directory.CreateDirectory(run);
            string desktop = acceptance != null ? run : Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var plan = CollectionPlan.Discover(run, desktop);
            if (acceptance != null) Fixtures.Prepare(plan);
            plan.Save(); return plan;
        }
        internal static CollectionResult Collect(CollectionPlan plan, Action<string, int> progress, CancellationToken cancel) {
            string engine = Engine();
            string executable = Assembly.GetExecutingAssembly().Location;
            var env = new List<string> {
                "USERPROFILE=" + Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "APPDATA=" + Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "LOCALAPPDATA=" + Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SystemRoot=" + Environment.GetEnvironmentVariable("SystemRoot")
            };
            var collectors = Probe.Groups.Select(group => new { run = new {
                collectorName = group, command = executable, args = new [] { "--probe", group, "--run", plan.Run }, timeout = "25s", ignoreParentEnvs = true, env = env.ToArray()
            }}).ToArray();
            string spec = Path.Combine(plan.Run, "collect.yaml");
            File.WriteAllText(spec, Privacy.Json.Serialize(new { apiVersion = "troubleshoot.sh/v1beta2", kind = "SupportBundle", metadata = new { name = "gea-windows-diagnostics" }, spec = new { hostCollectors = collectors } }), new UTF8Encoding(false));
            string redactor = Path.Combine(plan.Run, "redact.yaml");
            File.WriteAllText(redactor, Privacy.Json.Serialize(new { apiVersion = "troubleshoot.sh/v1beta2", kind = "Redactor", metadata = new { name = "gea-private-fields" }, spec = new { redactors = new [] { new { name = "private-fields", removals = new { regex = new [] {
                new { redactor = @"(?i)(\\{1,2}Users\\{1,2})(?P<mask>[^\\""\s]+)" },
                new { redactor = @"(/Users/)(?P<mask>[^/""\s]+)" },
                new { redactor = @"(?i)(Bearer\s+)(?P<mask>[^\s"";,]+)" },
                new { redactor = @"(?i)((?:access[_-]?token|refresh[_-]?token|password|secret|cookie|csrf|employeeId)[""\s:=]+)(?P<mask>[^\s"";,}]+)" }
            }}}}}}), new UTF8Encoding(false));
            string bundleBase = Path.Combine(plan.Run, "support");
            var args = new [] { spec, "--redactors", redactor, "--auto-update=false", "--auto-upload=false", "--interactive=false", "--load-cluster-specs=false", "--redact=true", "--output", bundleBase };
            progress("正在收集排障信息，通常需要十几秒。", 5);
            var start = new ProcessStartInfo(engine, String.Join(" ", args.Select(Quote))) { WorkingDirectory = plan.Run, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.EnvironmentVariables.Clear();
            foreach (var pair in new Dictionary<string, string> {
                { "SystemRoot", Environment.GetEnvironmentVariable("SystemRoot") }, { "WINDIR", Environment.GetEnvironmentVariable("SystemRoot") },
                { "PATH", Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"), "System32") }, { "TEMP", plan.Run }, { "TMP", plan.Run },
                { "USERPROFILE", Path.Combine(plan.Run, "isolated-profile") }, { "APPDATA", Path.Combine(plan.Run, "isolated-profile", "AppData", "Roaming") },
                { "TROUBLESHOOT_AUTO_UPDATE", "false" }
            }) start.EnvironmentVariables[pair.Key] = pair.Value;
            int exit;
            using (var job = new OwnedJob()) using (var process = new Process { StartInfo = start }) {
                process.Start(); job.Add(process);
                Task<string> stdout = process.StandardOutput.ReadToEndAsync(), stderr = process.StandardError.ReadToEndAsync();
                var clock = Stopwatch.StartNew();
                while (!process.WaitForExit(200)) {
                    cancel.ThrowIfCancellationRequested(); if (clock.Elapsed.TotalSeconds > 90) throw new IOException("COLLECTION_TIMEOUT");
                    int done = Probe.Groups.Count(g => File.Exists(Path.Combine(plan.Run, g + "-result.json")));
                    progress("正在收集排障信息（" + done + "/" + Probe.Groups.Length + "）。", 5 + done * 11);
                }
                exit = process.ExitCode;
                if (!Task.WaitAll(new Task[] { stdout, stderr }, 3000)) throw new IOException("ENGINE_OUTPUT_TIMEOUT");
                File.WriteAllText(Path.Combine(plan.Run, "engine-output.txt"), Privacy.Clean(stdout.Result + "\n" + stderr.Result), new UTF8Encoding(false));
            }
            cancel.ThrowIfCancellationRequested();
            string archive = bundleBase + ".tar.gz";
            if (exit != 0 || !File.Exists(archive)) throw new IOException("ENGINE_COLLECTION_FAILED");
            progress("正在检查报告并生成压缩包。", 80);
            cancel.ThrowIfCancellationRequested();
            var coverage = new List<object>(); bool partial = false;
            foreach (string group in Probe.Groups) {
                string result = Path.Combine(plan.Run, group + "-result.json");
                if (!File.Exists(result)) { partial = true; coverage.Add(new { group = group, state = "unavailable" }); }
                else {
                    var value = Privacy.Json.DeserializeObject(File.ReadAllText(result)) as IDictionary<string, object>;
                    if (value == null || Convert.ToString(value["state"]) != "collected" || Convert.ToInt32(value["found"]) == 0) partial = true;
                    coverage.Add(value);
                }
            }
            string packaging = Path.Combine(plan.Run, "package"); Directory.CreateDirectory(packaging);
            File.Copy(archive, Path.Combine(packaging, "诊断数据.tar.gz"));
            string summary = "GEA日志采集\r\n生成时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\r\n工具版本：" + BuildInfo.Version + "\r\n" + (partial ? "部分记录未获取，请结合收集清单判断。" : "已完成所有采集项目。") + "\r\n将整个 ZIP 文件发给技术支持，并补充故障大致时间和操作步骤。\r\n";
            File.WriteAllText(Path.Combine(packaging, "请先阅读.txt"), summary, new UTF8Encoding(true));
            Privacy.Save(Path.Combine(packaging, "收集清单.json"), new { version = BuildInfo.Version, timeUtc = DateTime.UtcNow.ToString("o"), partial = partial, groups = coverage, sourceLogWindowHours = 24, durableUpdateStateAgeLimited = false, credentialFilesCollected = false, sessionBodiesCollected = false });
            using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Troubleshoot.License")) using (var output = File.Create(Path.Combine(packaging, "Troubleshoot-LICENSE.txt"))) source.CopyTo(output);
            string target = Path.Combine(plan.Output, "GEA日志采集-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 4) + ".zip");
            Directory.CreateDirectory(plan.Output);
            string partialArchive = target + ".partial";
            try {
                ZipFile.CreateFromDirectory(packaging, partialArchive, CompressionLevel.Optimal, false);
                cancel.ThrowIfCancellationRequested(); File.Move(partialArchive, target);
            } finally { if (File.Exists(partialArchive)) File.Delete(partialArchive); }
            progress("日志包已保存。", 100);
            var completed = new CollectionResult { Archive = target, Partial = partial, Summary = summary + "文件名：" + Path.GetFileName(target) + "\r\n", Coverage = coverage.ToArray() };
            Privacy.Save(Path.Combine(plan.Run, "result.json"), new { status = "completed", partial = partial, archive = target, groups = coverage });
            return completed;
        }
        static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    }
    internal static class Fixtures {
        internal static void Prepare(CollectionPlan plan) {
            plan.Fixture = true; plan.InstallerLogs = Path.Combine(plan.Run, "sources", "installer"); plan.AppRoots = new [] { Path.Combine(plan.Run, "sources", "GEA Desktop") }; plan.Profiles = new [] { Path.Combine(plan.Run, "sources", "profile") };
            string package = Path.Combine(plan.Profiles[0], "node_modules", "@cleverc2200", "gea-dsh-prototype", "package.json");
            Directory.CreateDirectory(Path.GetDirectoryName(package)); File.WriteAllText(package, "{\"version\":\"0.0.287\"}");
            Directory.CreateDirectory(plan.InstallerLogs); File.WriteAllText(Path.Combine(plan.InstallerLogs, "stages-42.log"), "2026-11-13T10:00:00 [GEA-INSTALL-DIAG] pid=42 tickMs=1250 errors=1 copy-failed attempt=2\n");
            string logs = Path.Combine(plan.AppRoots[0], "logs"); Directory.CreateDirectory(logs);
            string seeded = "time: 2026-11-13T03:00:00Z\nsource: renderer\nTypeError: fixture\n  at fixture (C:\\Users\\fixture-person\\app.js:12:3)\nAuthorization: Bearer sensitive-fixture-bearer\nCookie: dsh-auth-test=sensitive-fixture-cookie\n";
            File.WriteAllText(Path.Combine(logs, "crash-fixture.log"), seeded, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(logs, "utf16-fixture.log"), seeded, Encoding.Unicode);
            File.WriteAllText(Path.Combine(logs, "runtime.jsonl"), "{\"event\":\"backend-error\",\"code\":\"UPDATE_PRECHECK_TIMEOUT\",\"requestId\":\"fixture-request-42\",\"body\":\"sensitive-fixture-body\",\"access_token\":\"sensitive-fixture-token\"}\n");
            string updates = Path.Combine(plan.Profiles[0], "gea", "plugin-updates", "operations"); Directory.CreateDirectory(updates);
            File.WriteAllText(Path.Combine(updates, "receipt.json"), "{\"id\":\"fixture-operation\",\"stage\":\"pending-restart\",\"password\":\"sensitive-fixture-password\"}");
            string requests = Path.Combine(plan.Profiles[0], "gea", "feedback-evidence", "owner", "session"); Directory.CreateDirectory(requests);
            File.WriteAllText(Path.Combine(requests, "requests.jsonl"), "{\"requestId\":\"fixture-request-42\",\"state\":\"failed\",\"httpStatus\":503,\"errorCode\":\"GEA_REQUEST_FAILED\",\"body\":\"sensitive-fixture-request-body\",\"responseHeaders\":{\"cookie\":\"sensitive-fixture-cookie\"}}\n");
            File.WriteAllText(Path.Combine(plan.Run, "fixture-event.log"), "ApplicationError UPDATE_PRECHECK_TIMEOUT\n");
        }
    }
}
