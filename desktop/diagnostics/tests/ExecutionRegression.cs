using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using GeaDiagnostics;

internal static class ExecutionRegression {
    static string output;
    static ProcessStartInfo Child(string mode, string marker) { return new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, mode + " \"" + marker + "\"") { UseShellExecute = false, CreateNoWindow = true }; }
    static int Main(string[] args) {
        if (args[0] == "--leaf") { Thread.Sleep(Timeout.Infinite); return 0; }
        if (args[0] == "--hang") {
            using (var child = Process.Start(Child("--leaf", args[1]))) {
                File.WriteAllText(args[1], Process.GetCurrentProcess().Id + "," + child.Id);
                Thread.Sleep(Timeout.Infinite);
            }
            return 0;
        }
        if (args[0] == "--no-report") return 0;
        output = args[0]; Directory.CreateDirectory(output);
        var failures = new List<string>();
        Check(failures, "timeout-isolates-process-tree-and-keeps-partial-report", delegate {
            var plan = Collection.Create(Path.Combine(Path.GetTempPath(), "GEA-light-timeout-" + Guid.NewGuid().ToString("N")));
            string marker = Path.Combine(plan.Run, "children.txt");
            Collection.RunGroup(plan, "startup", Child("--hang", marker), TimeSpan.FromSeconds(5), CancellationToken.None);
            Assert(File.Exists(marker), "CHILD_DID_NOT_START");
            foreach (int pid in File.ReadAllText(marker).Split(',').Select(Int32.Parse)) Assert(Gone(pid), "CHILD_SURVIVED_TIMEOUT");
            foreach (string group in Probe.Groups.Where(g => g != "startup")) new Probe(plan, group, Path.Combine(plan.Run, group + "-data")).Run();
            var result = Collection.Package(plan, delegate {}, CancellationToken.None);
            Assert(result.Partial, "TIMEOUT_NOT_PARTIAL");
            using (var zip = ZipFile.OpenRead(result.Archive)) {
                string text = Read(zip, "收集清单.json");
                Assert(text.Contains("PROBE_TIMEOUT") && text.Contains("\"timedOut\":true"), "TIMEOUT_NOT_REPORTED");
                Assert(zip.Entries.Any(e => e.FullName.StartsWith("诊断数据/requests/")), "OTHER_GROUP_LOST");
                Assert(!zip.Entries.Any(e => e.FullName.EndsWith(".tar.gz")), "NESTED_ARCHIVE");
                foreach (var entry in zip.Entries) Assert(!Read(zip, entry.FullName).Contains("sensitive-fixture-"), "SECRET_IN_ARCHIVE");
            }
        });
        Check(failures, "cancel-waits-for-owned-process-tree-and-preserves-unrelated-process", delegate {
            string marker = Path.Combine(output, "cancel-children.txt");
            using (var unrelated = Process.Start(Child("--leaf", marker))) using (var cancel = new CancellationTokenSource()) {
                var task = Task.Run(() => ProbeProcess.Run(Child("--hang", marker), TimeSpan.FromSeconds(45), cancel.Token));
                try {
                    var clock = Stopwatch.StartNew();
                    while (!File.Exists(marker) && !task.IsCompleted && clock.Elapsed < TimeSpan.FromSeconds(30)) Thread.Sleep(20);
                    Assert(File.Exists(marker), "CANCEL_CHILD_NOT_READY"); cancel.Cancel();
                    bool cancelled = false; try { task.GetAwaiter().GetResult(); } catch (OperationCanceledException) { cancelled = true; }
                    Assert(cancelled, "CANCEL_NOT_PROPAGATED");
                    foreach (int pid in File.ReadAllText(marker).Split(',').Select(Int32.Parse)) Assert(Gone(pid), "CHILD_SURVIVED_CANCEL");
                    Assert(!unrelated.HasExited, "UNRELATED_PROCESS_STOPPED");
                } finally {
                    cancel.Cancel(); try { task.GetAwaiter().GetResult(); } catch (OperationCanceledException) { }
                    if (!unrelated.HasExited) unrelated.Kill(); unrelated.WaitForExit();
                }
            }
        });
        Check(failures, "missing-child-result-is-explicit", delegate {
            var plan = Collection.Create(Path.Combine(Path.GetTempPath(), "GEA-light-missing-" + Guid.NewGuid().ToString("N")));
            Collection.RunGroup(plan, "startup", Child("--no-report", plan.Run), TimeSpan.FromSeconds(10), CancellationToken.None);
            string result = File.ReadAllText(Path.Combine(plan.Run, "startup-result.json"));
            Assert(result.Contains("PROBE_RESULT_MISSING") && result.Contains("\"state\":\"partial\""), "MISSING_LOOKS_HEALTHY");
        });
        Check(failures, "packaging-cancellation-does-not-publish-archive", delegate {
            var plan = Collection.Create(Path.Combine(Path.GetTempPath(), "GEA-light-packaging-" + Guid.NewGuid().ToString("N")));
            foreach (string group in Probe.Groups) new Probe(plan, group, Path.Combine(plan.Run, group + "-data")).Run();
            using (var cancel = new CancellationTokenSource()) {
                bool cancelled = false;
                try { Collection.Package(plan, delegate(string text, int percent) { cancel.Cancel(); }, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
                Assert(cancelled && Directory.GetFiles(plan.Output, "*.zip*").Length == 0, "CANCELLED_ARCHIVE_PUBLISHED");
            }
        });
        File.WriteAllText(Path.Combine(output, "execution-regression.json"), Privacy.Json.Serialize(new { passed = failures.Count == 0, failures = failures }));
        foreach (string failure in failures) Console.WriteLine("FAILED " + failure);
        return failures.Count == 0 ? 0 : 1;
    }
    static bool Gone(int pid) { try { using (var process = Process.GetProcessById(pid)) return process.HasExited; } catch (ArgumentException) { return true; } }
    static string Read(ZipArchive zip, string name) { using (var stream = zip.GetEntry(name).Open()) using (var reader = new StreamReader(stream)) return reader.ReadToEnd(); }
    static void Assert(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
    static void Check(List<string> failures, string name, Action action) { try { action(); } catch (Exception error) { failures.Add(name + ":" + error.GetType().Name + ":" + error.Message); } }
}
