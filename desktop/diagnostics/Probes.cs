using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.IO;
using System.Linq;
using System.Management;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace GeaDiagnostics {
    internal sealed class CollectionPlan {
        public string Run;
        public string Output;
        public string[] AppRoots;
        public string[] Profiles;
        public bool Fixture;
        public string InstallerLogs;
        internal static CollectionPlan Discover(string run, string output) {
            var homes = new List<string> { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh") };
            string configured = Environment.GetEnvironmentVariable("DSH_HOME");
            if (!String.IsNullOrWhiteSpace(configured) && Path.IsPathRooted(configured)) homes.Insert(0, configured);
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var appRoots = new List<string> { Path.Combine(roaming, "GEA Desktop"), Path.Combine(roaming, "Synear GEA"), Path.Combine(roaming, "dsh-gea-desktop"), Path.Combine(roaming, "DeepSeek Harness"), Path.Combine(roaming, "deepseek-harness") };
            foreach (string key in new [] { "DSH_GEA_DESKTOP_DATA", "DSH_DESKTOP_USER_DATA_DIR" }) {
                string path = Environment.GetEnvironmentVariable(key); if (!String.IsNullOrWhiteSpace(path) && Path.IsPathRooted(path) && !path.StartsWith(@"\\", StringComparison.Ordinal)) appRoots.Insert(0, path);
            }
            return new CollectionPlan { InstallerLogs = Path.Combine(Path.GetTempPath(), "GEA-Install-Diagnostics"), Run = run, Output = output, AppRoots = appRoots.Distinct(StringComparer.OrdinalIgnoreCase).ToArray(), Profiles = homes.Distinct().Select(p => Path.Combine(p, "profiles", "desktop")).ToArray() };
        }
        internal void Save() { File.WriteAllText(Path.Combine(Run, "plan.json"), Privacy.Json.Serialize(this), new UTF8Encoding(false)); }
        internal static CollectionPlan Load(string run) { return Privacy.Json.Deserialize<CollectionPlan>(File.ReadAllText(Path.Combine(run, "plan.json"))); }
    }
    internal sealed class Probe {
        readonly CollectionPlan plan;
        readonly string group;
        readonly string output;
        readonly List<object> coverage = new List<object>();
        int bytes;
        int sequence;
        readonly DateTime since = DateTime.UtcNow.AddHours(-24);
        internal static readonly string[] Groups = { "environment", "startup", "updates", "requests", "events", "performance" };
        internal Probe(CollectionPlan value, string name, string directory) { plan = value; group = name; output = directory; }
        internal int Run() {
            if (!Groups.Contains(group)) throw new ArgumentException("UNKNOWN_PROBE");
            Directory.CreateDirectory(output);
            string status = "collected";
            try {
                switch (group) {
                    case "environment": EnvironmentProbe(); break;
                    case "startup": Logs(); break;
                    case "updates": Updates(); break;
                    case "requests": Requests(); break;
                    case "events": Events(); break;
                    case "performance": Performance(); break;
                }
            } catch (Exception error) { status = "partial"; coverage.Add(new { state = "unavailable", code = ErrorCode(error) }); }
            if (coverage.Any(item => { var value = Privacy.Json.DeserializeObject(Privacy.Json.Serialize(item)) as IDictionary<string, object>; return value != null && value.ContainsKey("state") && new [] { "missing", "unavailable", "limited" }.Contains(Convert.ToString(value["state"])); })) status = "partial";
            Privacy.Save(Path.Combine(output, "coverage.json"), new { group = group, status = status, items = coverage, bytes = bytes });
            Privacy.Save(Path.Combine(plan.Run, group + "-result.json"), new { group = group, state = status, found = sequence, unavailable = coverage.Count(item => Privacy.Json.Serialize(item).Contains("\"unavailable\"")), bytes = bytes });
            return status == "collected" ? 0 : 1;
        }
        static string ErrorCode(Exception error) { return error is UnauthorizedAccessException ? "ACCESS_DENIED" : error is IOException ? "SOURCE_UNAVAILABLE" : error.GetType().Name; }
        bool Text(string label, string content) {
            content = Privacy.Clean(content);
            int size = Encoding.UTF8.GetByteCount(content);
            if (bytes + size > 3 * 1024 * 1024) { coverage.Add(new { source = label, state = "limited", code = "GROUP_SIZE_LIMIT" }); return false; }
            File.WriteAllText(Path.Combine(output, label + ".txt"), content, new UTF8Encoding(false)); bytes += size; sequence++; return true;
        }
        void Json(string label, object content) { Text(label, Privacy.Json.Serialize(content)); }
        IEnumerable<string> Files(string root, int depth, int limit, Func<string, bool> include, bool recentOnly = true) {
            var found = new List<string>();
            var pending = new Queue<KeyValuePair<string, int>>(); pending.Enqueue(new KeyValuePair<string, int>(root, 0));
            int visited = 0;
            while (pending.Count > 0 && found.Count <= limit && visited++ < 300) {
                var next = pending.Dequeue();
                try {
                    if (!Directory.Exists(next.Key)) continue;
                    if ((File.GetAttributes(next.Key) & FileAttributes.ReparsePoint) != 0) { coverage.Add(new { source = group, state = "skipped", code = "LINKED_DIRECTORY" }); continue; }
                    foreach (string file in Directory.GetFiles(next.Key).OrderByDescending(File.GetLastWriteTimeUtc)) {
                        if (!include(file)) continue;
                        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0 && (!recentOnly || File.GetLastWriteTimeUtc(file) >= since)) found.Add(file);
                        if (found.Count > limit) break;
                    }
                    if (next.Value < depth) foreach (string dir in Directory.GetDirectories(next.Key)) pending.Enqueue(new KeyValuePair<string, int>(dir, next.Value + 1));
                } catch (Exception error) { coverage.Add(new { source = group, state = "unavailable", code = ErrorCode(error) }); }
            }
            if (visited >= 300) coverage.Add(new { source = group, state = "limited", code = "DIRECTORY_COUNT_LIMIT" });
            if (found.Count > limit) coverage.Add(new { source = group, state = "limited", code = "FILE_COUNT_LIMIT" });
            return found.Take(limit);
        }
        static string SourceLabel(string file) {
            string name = Path.GetFileName(file);
            if (name == "requests.jsonl") return "request-metadata";
            if (name.StartsWith("crash-")) return "crash-log";
            if (name.StartsWith("stages-")) return "installer-stages";
            if (name == "company-update.json") return "desktop-update-state";
            if (name.StartsWith("company-update-")) return "desktop-update-history";
            if (name == "latest.json") return "update-operation-pointer";
            if (name == "receipt.json") return "update-receipt";
            return "technical" + Path.GetExtension(file);
        }
        void Source(string file, bool structured) {
            try {
                if (new FileInfo(file).Length > 1024 * 1024) coverage.Add(new { source = SourceLabel(file), state = "limited", code = "SOURCE_TAIL_LIMIT" });
                string raw = Privacy.ReadBounded(file, 1024 * 1024);
                string content;
                if (structured && Path.GetExtension(file).Equals(".json", StringComparison.OrdinalIgnoreCase)) content = Privacy.StructuredText(raw);
                else content = Privacy.TechnicalText(raw);
                if (String.IsNullOrWhiteSpace(content) || (content == "{}" || content == "[]")) { coverage.Add(new { source = Path.GetExtension(file), state = "excluded", code = "NO_DIAGNOSTIC_FIELDS" }); return; }
                if (content.Contains("[incomplete-structured-record]")) coverage.Add(new { source = SourceLabel(file), state = "limited", code = "INCOMPLETE_RECORDS" });
                if (!Text("record-" + sequence, content)) return;
                coverage.Add(new { source = SourceLabel(file), state = "collected", lastModifiedUtc = File.GetLastWriteTimeUtc(file).ToString("o"), encoding = "utf8-normalized", projection = "technical-fields" });
            } catch (Exception error) { coverage.Add(new { source = SourceLabel(file), state = "unavailable", code = ErrorCode(error) }); }
        }
        void Logs() {
            var launches = new List<ClientLaunch>();
            if (!plan.Fixture) {
                try { launches = ClientStartup.Read(); Json("launch-snapshot", new { source = "windows-process-observation", capturedUtc = DateTime.UtcNow.ToString("o"), historicalConsoleOutput = false, processes = launches }); }
                catch (Exception error) { coverage.Add(new { source = "launch-snapshot", state = "unavailable", code = ErrorCode(error) }); }
            }
            int before = sequence;
            var roots = ClientStartup.Roots(plan, launches).ToArray();
            foreach (string root in roots) {
                foreach (string file in Files(Path.Combine(root, "logs"), 2, 45, p => new [] { ".log", ".jsonl" }.Contains(Path.GetExtension(p).ToLowerInvariant()))) Source(file, false);
                string legacy = Path.Combine(root, "desktop.log"); if (File.Exists(legacy)) Source(legacy, false);
            }
            if (before == sequence) {
                foreach (string root in roots) foreach (string file in Files(Path.Combine(root, "logs"), 2, 5, path => new [] { ".log", ".jsonl" }.Contains(Path.GetExtension(path).ToLowerInvariant()), false)) {
                    int count = sequence; Source(file, false);
                    if (sequence > count) coverage.Add(new { source = "historical-client-log", state = "collected", lastModifiedUtc = File.GetLastWriteTimeUtc(file).ToString("o") });
                }
            }
            if (before == sequence) coverage.Add(new { source = "client-logs", state = "missing", code = "NO_PERSISTED_STARTUP_LOG", currentProcessCount = launches.Count, searchedDirectories = roots.Select(path => Privacy.Clean(Path.Combine(path, "logs"))).ToArray() });
        }
        void Updates() {
            int before = sequence;
            foreach (string profile in plan.Profiles) {
                var stateFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                string updateRoot = Path.Combine(profile, "gea", "plugin-updates");
                foreach (string file in Files(Path.Combine(profile, "gea"), 1, 2, p => String.Equals(Path.GetDirectoryName(p), updateRoot, StringComparison.OrdinalIgnoreCase) && (Path.GetFileName(p) == "company-update.json" || Path.GetFileName(p) == "latest.json"), false)) {
                    stateFiles.Add(file);
                    Source(file, true);
                    if (Path.GetFileName(file) != "latest.json") continue;
                    try {
                        var pointer = Privacy.Json.DeserializeObject(Privacy.ReadBounded(file, 4096)) as IDictionary<string, object>;
                        object value;
                        Guid id;
                        if (pointer == null || !pointer.TryGetValue("id", out value) || !(value is string) || !Guid.TryParse((string)value, out id)) throw new IOException("UPDATE_POINTER_INVALID");
                        string operations = Path.Combine(profile, "gea", "plugin-updates", "operations");
                        if (!Directory.Exists(operations)) continue;
                        if ((File.GetAttributes(operations) & FileAttributes.ReparsePoint) != 0) throw new IOException("LINKED_SOURCE_SKIPPED");
                        foreach (string receipt in Files(Path.Combine(operations, id.ToString()), 0, 1, p => Path.GetFileName(p) == "receipt.json", false)) { stateFiles.Add(receipt); Source(receipt, true); }
                    } catch (Exception error) { coverage.Add(new { source = "update-operation-pointer", state = "unavailable", code = ErrorCode(error) }); }
                }
                foreach (string relative in new [] { "gea/plugin-updates", "gea/bootstrap", "gea/bundled-refresh" })
                    foreach (string file in Files(Path.Combine(profile, relative.Replace('/', Path.DirectorySeparatorChar)), 3, 60, p => !stateFiles.Contains(p) && Path.GetExtension(p).Equals(".json", StringComparison.OrdinalIgnoreCase) && !Path.GetFileName(p).StartsWith("before-") && !Path.GetFileName(p).Equals("package.json", StringComparison.OrdinalIgnoreCase) && Path.GetFileName(p) != "windows-job-ack.json")) {
                        Source(file, true);
                    }
                foreach (string file in Files(Path.Combine(profile, ".plugin-manager/logs"), 2, 12, p => Path.GetExtension(p).Equals(".log", StringComparison.OrdinalIgnoreCase))) Source(file, false);
            }
            foreach (string root in plan.AppRoots) foreach (string file in Files(Path.Combine(root, "logs/updates"), 0, 10, p => Path.GetExtension(p).Equals(".jsonl", StringComparison.OrdinalIgnoreCase))) Source(file, false);
            foreach (string file in Files(plan.InstallerLogs, 0, 20, p => Regex.IsMatch(Path.GetFileName(p), @"^stages-\d+\.log$"))) Source(file, false);
            if (before == sequence) coverage.Add(new { source = "update-records", state = "missing", code = "NO_UPDATE_RECORDS" });
        }
        void Requests() {
            int before = sequence;
            foreach (string profile in plan.Profiles) {
                foreach (string root in new [] { Path.Combine(profile, "gea/feedback-evidence"), Path.Combine(profile, "gea/runtime/feedback-evidence"), Path.Combine(profile, "feedback-evidence") })
                    foreach (string file in Files(root, 3, 30, p => Path.GetFileName(p) == "requests.jsonl")) Source(file, false);
            }
            if (before == sequence) coverage.Add(new { source = "request-metadata", state = "missing", code = "NO_REQUEST_CAPTURE" });
        }
        void EnvironmentProbe() {
            var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            Json("system", new { version = BuildInfo.Version, os = Environment.OSVersion.VersionString, architecture = Environment.Is64BitOperatingSystem ? "x64" : "x86", elevated = principal.IsInRole(WindowsBuiltInRole.Administrator), timezone = TimeZoneInfo.Local.Id, timeUtc = DateTime.UtcNow.ToString("o"), processorCount = Environment.ProcessorCount });
            var volumes = DriveInfo.GetDrives().Where(d => d.IsReady && d.DriveType == DriveType.Fixed).Select(d => new { drive = d.Name, freeBytes = d.AvailableFreeSpace, totalBytes = d.TotalSize }).ToArray(); Json("disks", volumes);
            int count = 0;
            foreach (string profile in plan.Profiles) {
                var packages = new Dictionary<string, object>();
                foreach (string name in new [] { "@cleverc2200/gea-dsh-prototype", "@cleverc2200/dsh-agent-workbench", "dsh-agent-manage", "@cleverc2200/dsh-personal-memory" }) {
                    string manifest = Path.Combine(profile, "node_modules", name.Replace('/', Path.DirectorySeparatorChar), "package.json");
                    try { if (!File.Exists(manifest)) continue; var value = Privacy.Json.DeserializeObject(Privacy.ReadBounded(manifest, 262144)) as IDictionary<string, object>; if (value != null && value.ContainsKey("version")) packages[name] = value["version"]; } catch (Exception error) { coverage.Add(new { source = name, state = "unavailable", code = ErrorCode(error) }); }
                }
                if (packages.Count > 0) Json("plugin-versions-" + count++, packages);
            }
            if (count == 0) coverage.Add(new { source = "plugin-versions", state = "missing", code = "NO_PLUGIN_MANIFESTS" });
            if (plan.Fixture) { Json("network", new { state = "fixture", activeProbes = false }); return; }
            using (var search = new ManagementObjectSearcher("SELECT Caption,Version,TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem")) {
                foreach (ManagementObject row in search.Get()) using (row) Json("os-memory", new { caption = row["Caption"], version = row["Version"], totalMemoryKiB = row["TotalVisibleMemorySize"], freeMemoryKiB = row["FreePhysicalMemory"] });
            }
            try { using (var search = new ManagementObjectSearcher("root\\SecurityCenter2", "SELECT displayName,productState FROM AntiVirusProduct")) {
                var products = new List<object>(); foreach (ManagementObject row in search.Get()) using (row) products.Add(new { name = row["displayName"], state = row["productState"] }); Json("security-products", products);
            }} catch (ManagementException) { coverage.Add(new { source = "security-products", state = "unavailable", code = "SECURITY_STATUS_UNAVAILABLE" }); }
            Json("network", new [] { "gea.synear.cn", "synear-gea.oss-cn-hangzhou.aliyuncs.com" }.Select(NetworkProbe.Inspect).ToArray());
            using (var search = new ManagementObjectSearcher("SELECT Name,ExecutablePath FROM Win32_Process WHERE Name='GEA Desktop.exe' OR Name='Synear GEA.exe'")) {
                var values = new List<object>(); foreach (ManagementObject row in search.Get()) { string executable = row["ExecutablePath"] as string; string version = executable != null && File.Exists(executable) ? FileVersionInfo.GetVersionInfo(executable).ProductVersion : null; values.Add(new { executable = executable, version = version }); } Json("client-versions", values);
            }
        }
        void Events() {
            if (plan.Fixture) { Source(Path.Combine(plan.Run, "fixture-event.log"), false); return; }
            int count = 0;
            foreach (string channel in new [] { "Application", "Microsoft-Windows-Windows Defender/Operational", "Microsoft-Windows-CodeIntegrity/Operational" }) {
                try {
                    string query = "*[System[TimeCreated[timediff(@SystemTime) <= 86400000] and (Level=1 or Level=2 or Level=3)]]";
                    using (var reader = new EventLogReader(new EventLogQuery(channel, PathType.LogName, query) { ReverseDirection = true })) {
                        var rows = new List<object>(); EventRecord record;
                        int visited = 0;
                        while (visited++ < 300 && rows.Count < 70 && (record = reader.ReadEvent()) != null) using (record) {
                            string description = ""; try { description = record.FormatDescription() ?? ""; } catch (EventLogException) { }
                            if (!Regex.IsMatch(description + " " + record.ProviderName, "(?i)GEA|deepseek|support-bundle|诊断")) continue;
                            var codes = Regex.Matches(description, @"\b0x[0-9a-fA-F]{4,16}\b").Cast<Match>().Select(m => m.Value).Distinct().ToArray();
                            rows.Add(new { eventId = record.Id, provider = record.ProviderName, timestamp = record.TimeCreated, level = record.LevelDisplayName, codes = codes, processId = record.ProcessId });
                        }
                        Json("events-" + count++, rows);
                    }
                } catch (Exception error) { coverage.Add(new { source = channel, state = "unavailable", code = ErrorCode(error) }); }
            }
        }
        void Performance() {
            if (plan.Fixture) { Json("process-samples", new [] { new { name = "GEA Desktop", pid = 42, workingBytes = 1024, sample = 1 } }); return; }
            var samples = new List<object>();
            for (int index = 0; index < 4; index++) {
                var owned = new HashSet<int>(); var roster = new List<ManagementBaseObject>();
                using (var search = new ManagementObjectSearcher("SELECT Name,ProcessId,ParentProcessId FROM Win32_Process")) {
                    foreach (ManagementBaseObject row in search.Get()) roster.Add(row);
                    foreach (var row in roster) if (Regex.IsMatch((string)row["Name"], "(?i)^(GEA Desktop|Synear GEA)\\.exe$")) owned.Add(Convert.ToInt32(row["ProcessId"]));
                    bool changed; do { changed = false; foreach (var row in roster) if (owned.Contains(Convert.ToInt32(row["ParentProcessId"])) && owned.Add(Convert.ToInt32(row["ProcessId"]))) changed = true; } while (changed);
                    foreach (var row in roster.Where(r => owned.Contains(Convert.ToInt32(r["ProcessId"])))) {
                        try { using (var process = Process.GetProcessById(Convert.ToInt32(row["ProcessId"]))) samples.Add(new { sample = index, timeUtc = DateTime.UtcNow.ToString("o"), pid = process.Id, parentPid = row["ParentProcessId"], name = process.ProcessName, cpuMs = process.TotalProcessorTime.TotalMilliseconds, workingBytes = process.WorkingSet64, threads = process.Threads.Count, responding = process.Responding }); } catch (InvalidOperationException) { }
                    }
                    foreach (var row in roster) row.Dispose();
                }
                if (index < 3) Thread.Sleep(1500);
            }
            Json("process-samples", samples);
            if (samples.Count == 0) coverage.Add(new { source = "client-processes", state = "missing", code = "CLIENT_NOT_RUNNING" });
        }
    }
}
