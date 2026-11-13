using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using GeaDiagnostics;

internal static class LogRegression {
    static int Main(string[] args) {
        var failures = new List<string>();
        Check(failures, "pretty-json", delegate {
            string output = Privacy.TechnicalText("{\n  \"stage\": \"completed\",\n  \"exitCode\": 0,\n  \"body\": \"private-body-canary\"\n}");
            return output.Contains("completed") && !output.Contains("incomplete") && !output.Contains("private-body-canary");
        });
        Check(failures, "bracket-prefix", delegate {
            string output = Privacy.TechnicalText("[stderr] ERR_PNPM_FETCH_503 private-body-canary\n[stdout] Progress: resolved 12, reused 8, downloaded 4, added 12, done\n[stdout] Done in 2.4s using pnpm v11.27.0");
            return output.Contains("ERR_PNPM_FETCH_503") && output.Contains("resolved 12") && !output.Contains("incomplete") && !output.Contains("private-body-canary");
        });
        Check(failures, "receipt-projection", delegate {
            string output = Privacy.Json.Serialize(Privacy.Project(Privacy.Json.DeserializeObject("{\"schema\":1,\"status\":\"completed\",\"result\":{\"exitCode\":0},\"targets\":[{\"name\":\"@cleverc2200/gea-dsh-prototype\",\"version\":\"0.0.290\"}],\"body\":\"private-body-canary\"}")));
            return output.Contains("exitCode") && output.Contains("@cleverc2200/gea-dsh-prototype") && !output.Contains("private-body-canary");
        });
        Check(failures, "eligible-file-limit", delegate {
            string run = Path.Combine(args[0], "file-limit"); Directory.CreateDirectory(run);
            string profile = Path.Combine(run, "profile"), updates = Path.Combine(profile, "gea", "plugin-updates"); Directory.CreateDirectory(updates);
            File.WriteAllText(Path.Combine(updates, "receipt.json"), "{\"stage\":\"completed\",\"operationId\":\"public-operation\"}");
            for (int index = 0; index < 65; index++) File.WriteAllText(Path.Combine(updates, "archive-" + index + ".tgz"), "not-a-log");
            var plan = new CollectionPlan { Run = run, Output = run, AppRoots = new string[0], Profiles = new [] { profile }, Fixture = true, InstallerLogs = Path.Combine(run, "installer") };
            string output = Path.Combine(run, "output"); new Probe(plan, "updates", output).Run();
            string combined = String.Join("\n", Directory.GetFiles(output).Select(File.ReadAllText));
            if (!combined.Contains("public-operation") || combined.Contains("FILE_COUNT_LIMIT")) return false;
            for (int index = 0; index < 59; index++) File.WriteAllText(Path.Combine(updates, "receipt-" + index + ".json"), "{\"stage\":\"completed\"}");
            string exact = Path.Combine(run, "exact-limit"); new Probe(plan, "updates", exact).Run();
            return !File.ReadAllText(Path.Combine(exact, "coverage.json")).Contains("FILE_COUNT_LIMIT");
        });
        Check(failures, "latest-historical-startup-log", delegate {
            string run = Path.Combine(args[0], "historical"); Directory.CreateDirectory(run);
            string app = Path.Combine(run, "app"); Directory.CreateDirectory(Path.Combine(app, "logs"));
            string log = Path.Combine(app, "logs", "crash-old.log"); File.WriteAllText(log, "source: renderer\nTypeError: private-body-canary\n"); File.SetLastWriteTimeUtc(log, DateTime.UtcNow.AddDays(-3));
            var plan = new CollectionPlan { Run = run, Output = run, AppRoots = new [] { app }, Profiles = new string[0], Fixture = true, InstallerLogs = Path.Combine(run, "installer") };
            string output = Path.Combine(run, "output"); new Probe(plan, "startup", output).Run();
            string combined = String.Join("\n", Directory.GetFiles(output).Select(File.ReadAllText));
            return combined.Contains("TypeError") && combined.Contains("historical-client-log") && !combined.Contains("private-body-canary");
        });
        Check(failures, "custom-user-data-directory", delegate {
            string root = ClientStartup.UserDataArgument("GEA.exe --type=renderer --user-data-dir=\"C:\\Users\\fixture-user\\Custom App\" --token=private-token-canary");
            return root == @"C:\Users\fixture-user\Custom App" && ClientStartup.UserDataArgument("GEA.exe --user-data-dir=relative") == null;
        });
        File.WriteAllText(Path.Combine(args[0], "log-regression.json"), new JavaScriptSerializer().Serialize(new { failed = failures.ToArray(), passed = failures.Count == 0 }));
        foreach (string failure in failures) Console.WriteLine("FAILED " + failure);
        return failures.Count == 0 ? 0 : 1;
    }
    static void Check(List<string> failures, string name, Func<bool> test) { try { if (!test()) failures.Add(name); } catch (Exception error) { failures.Add(name + ":" + error.GetType().Name); } }
}
