using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
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
    internal static class Collection {
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
        internal static ProcessStartInfo ProbeStart(CollectionPlan plan, string group) {
            var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--probe " + group + " --run \"" + plan.Run + "\"") { WorkingDirectory = plan.Run, UseShellExecute = false, CreateNoWindow = true };
            start.EnvironmentVariables.Clear();
            foreach (var pair in new Dictionary<string, string> {
                { "SystemRoot", Environment.GetEnvironmentVariable("SystemRoot") }, { "WINDIR", Environment.GetEnvironmentVariable("SystemRoot") },
                { "PATH", Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"), "System32") }, { "TEMP", plan.Run }, { "TMP", plan.Run },
                { "USERPROFILE", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) },
                { "APPDATA", Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData) },
                { "LOCALAPPDATA", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) }
            }) start.EnvironmentVariables[pair.Key] = pair.Value;
            return start;
        }
        internal static void RunGroup(CollectionPlan plan, string group, ProcessStartInfo start, TimeSpan timeout, CancellationToken cancel) {
            try {
                var execution = ProbeProcess.Run(start, timeout, cancel);
                if (execution.TimedOut) GroupFailure(plan, group, "PROBE_TIMEOUT", execution);
                else if (!File.Exists(Path.Combine(plan.Run, group + "-result.json"))) GroupFailure(plan, group, "PROBE_RESULT_MISSING", execution);
                else if (execution.ExitCode != 0) {
                    var result = Privacy.Json.DeserializeObject(File.ReadAllText(Path.Combine(plan.Run, group + "-result.json"))) as IDictionary<string, object>;
                    if (result == null || Convert.ToString(result["state"]) != "partial") GroupFailure(plan, group, "PROBE_EXIT_FAILED", execution);
                }
            } catch (OperationCanceledException) { throw; }
            catch (ProbeStopException) { throw; }
            catch (Exception error) { GroupFailure(plan, group, error is System.ComponentModel.Win32Exception ? "PROBE_START_FAILED" : "PROBE_UNAVAILABLE", null); }
        }
        internal static void GroupFailure(CollectionPlan plan, string group, string code, ProbeExecution execution) {
            string directory = Path.Combine(plan.Run, group + "-data"); Directory.CreateDirectory(directory);
            var issue = new { source = group, state = "unavailable", code = code, timedOut = execution != null && execution.TimedOut, exitCode = execution == null ? (int?)null : execution.ExitCode };
            Privacy.Save(Path.Combine(directory, "execution.json"), issue);
            if (!File.Exists(Path.Combine(directory, "coverage.json"))) Privacy.Save(Path.Combine(directory, "coverage.json"), new { group = group, status = "partial", items = new [] { issue } });
            Privacy.Save(Path.Combine(plan.Run, group + "-result.json"), new { group = group, state = "partial", found = Directory.GetFiles(directory).Length, unavailable = 1, code = code, timedOut = execution != null && execution.TimedOut, exitCode = execution == null ? (int?)null : execution.ExitCode });
        }
        internal static CollectionResult Collect(CollectionPlan plan, Action<string, int> progress, CancellationToken cancel) {
            cancel.ThrowIfCancellationRequested();
            progress("正在收集排障信息，通常需要十几秒。", 5);
            var tasks = Probe.Groups.Select(group => Task.Run(() => RunGroup(plan, group, ProbeStart(plan, group), TimeSpan.FromSeconds(25), cancel))).ToArray();
            var all = Task.WhenAll(tasks); int previous = -1;
            while (!all.IsCompleted) {
                int done = tasks.Count(task => task.IsCompleted);
                if (done != previous) { progress("正在收集排障信息（" + done + "/" + Probe.Groups.Length + "）。", 5 + done * 11); previous = done; }
                Thread.Sleep(100);
            }
            all.GetAwaiter().GetResult();
            cancel.ThrowIfCancellationRequested();
            return Package(plan, progress, cancel);
        }
        internal static CollectionResult Package(CollectionPlan plan, Action<string, int> progress, CancellationToken cancel) {
            progress("正在检查报告并生成压缩包。", 80);
            cancel.ThrowIfCancellationRequested();
            var coverage = new List<object>(); bool partial = false;
            foreach (string group in Probe.Groups) {
                string path = Path.Combine(plan.Run, group + "-result.json");
                if (!File.Exists(path)) { GroupFailure(plan, group, "PROBE_RESULT_MISSING", null); partial = true; }
                var value = Privacy.Json.DeserializeObject(File.ReadAllText(path)) as IDictionary<string, object>;
                if (value == null || Convert.ToString(value["state"]) != "collected" || Convert.ToInt32(value["found"]) == 0) partial = true;
                coverage.Add(value);
            }
            string summary = "GEA日志采集\r\n生成时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\r\n工具版本：" + BuildInfo.Version + "\r\n" + (partial ? "部分记录未获取，请结合收集清单判断。" : "已完成所有采集项目。") + "\r\n将整个 ZIP 文件发给技术支持，并补充故障大致时间和操作步骤。\r\n";
            string target = Path.Combine(plan.Output, "GEA日志采集-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 4) + ".zip");
            Directory.CreateDirectory(plan.Output);
            string temporary = target + ".partial";
            try {
                using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) using (var zip = new ZipArchive(file, ZipArchiveMode.Create, false, Encoding.UTF8)) {
                    AddText(zip, "请先阅读.txt", summary, cancel);
                    AddText(zip, "收集清单.json", Privacy.Json.Serialize(new { version = BuildInfo.Version, timeUtc = DateTime.UtcNow.ToString("o"), partial = partial, groups = coverage, sourceLogWindowHours = 24, durableUpdateStateAgeLimited = false, credentialFilesCollected = false, sessionBodiesCollected = false }), cancel);
                    foreach (string group in Probe.Groups) foreach (string source in Directory.GetFiles(Path.Combine(plan.Run, group + "-data")).OrderBy(Path.GetFileName)) {
                        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("LINKED_OUTPUT_SKIPPED");
                        AddText(zip, "诊断数据/" + group + "/" + Path.GetFileName(source), File.ReadAllText(source, Encoding.UTF8), cancel);
                    }
                }
                cancel.ThrowIfCancellationRequested(); File.Move(temporary, target);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
            progress("日志包已保存。", 100);
            Privacy.Save(Path.Combine(plan.Run, "result.json"), new { status = "completed", partial = partial, archive = target, groups = coverage });
            return new CollectionResult { Archive = target, Partial = partial, Summary = summary + "文件名：" + Path.GetFileName(target) + "\r\n", Coverage = coverage.ToArray() };
        }
        static void AddText(ZipArchive zip, string name, string text, CancellationToken cancel) {
            cancel.ThrowIfCancellationRequested();
            var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
            byte[] bytes = Encoding.UTF8.GetBytes(Privacy.Clean(text));
            using (var output = entry.Open()) for (int offset = 0; offset < bytes.Length; offset += 16384) { cancel.ThrowIfCancellationRequested(); output.Write(bytes, offset, Math.Min(16384, bytes.Length - offset)); }
        }
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
