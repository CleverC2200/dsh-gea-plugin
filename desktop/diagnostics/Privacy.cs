using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace GeaDiagnostics {
    internal static class Privacy {
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024, RecursionLimit = 32 };
        static readonly Regex Secret = new Regex(@"(?i)([""']?(?:authorization|access[_-]?token|refresh[_-]?token|token|password|secret|csrf|api[_-]?key|cookie|set-cookie|employeeId)[""']?\s*[:=]\s*)(?:""[^""\r\n]*""|'[^'\r\n]*'|[^\s,;}]+)", RegexOptions.Compiled);
        static readonly Regex Bearer = new Regex(@"(?i)(Bearer\s+)[^\s"";,]+", RegexOptions.Compiled);
        static readonly Regex WindowsUser = new Regex(@"(?i)(\\{1,2}Users\\{1,2})[^\\""\s]+", RegexOptions.Compiled);
        static readonly Regex MacUser = new Regex(@"(/Users/)[^/""\s]+", RegexOptions.Compiled);
        static readonly Regex Query = new Regex(@"(https?://[^\s""'?#]+)\?[^\s""']+", RegexOptions.Compiled);
        static readonly Regex Email = new Regex(@"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        static readonly HashSet<string> Keys = new HashSet<string>(new [] {
            "schema", "schemaVersion", "id", "operationId", "timestamp", "time", "startedAt", "endedAt", "updatedAt", "createdAt", "completedAt",
            "stage", "phase", "state", "status", "code", "errorCode", "source", "event", "sequence", "seq", "pid", "processId", "processIdentity",
            "version", "desktopVersion", "installedVersion", "runningHostVersion", "runningClientVersion", "candidateVersion", "targetVersion", "planId", "kind", "packageName",
            "requestId", "traceId", "requestType", "retryOfRequestId", "parentRequestId", "apiLogId", "method", "httpStatus", "durationMs", "elapsedMs",
            "count", "failedOperation", "errorType", "exitCode", "signal", "shutdownCompleted", "platform", "arch", "lineNumber",
            "channel", "revision", "issuedAt", "expiresAt", "changed", "from", "to", "targetPid", "grouped", "sawAlive", "head"
        }, StringComparer.OrdinalIgnoreCase);
        internal static string Clean(string value) {
            value = value ?? "";
            value = Bearer.Replace(value, "$1<REDACTED>");
            value = Secret.Replace(value, "$1<REDACTED>");
            value = Regex.Replace(value, @"(?i)(dsh-auth-[^=\s]+)=[^;\s]+", "$1=<REDACTED>");
            value = Regex.Replace(value, @"(https?://)[^/\s@]+@", "$1<REDACTED>@");
            value = Query.Replace(value, "$1?<REDACTED>");
            value = WindowsUser.Replace(value, "$1<USER>");
            value = MacUser.Replace(value, "$1<USER>");
            return Email.Replace(value, "<EMAIL>");
        }
        internal static IDictionary<string, object> Project(object value) { return Project(value, 0); }
        static IDictionary<string, object> Project(object value, int depth) {
            var input = value as IDictionary<string, object>;
            var result = new Dictionary<string, object>();
            if (input == null) return result;
            foreach (var pair in input) {
                if (pair.Key == "name" && pair.Value is string && Regex.IsMatch((string)pair.Value, @"^(?:@cleverc2200/(?:gea-dsh-prototype|dsh-agent-workbench|dsh-personal-memory)|dsh-agent-manage|@deepseek-ai/dsh(?:-[a-z0-9-]+)?)$")) { result[pair.Key] = pair.Value; continue; }
                if (pair.Key == "diagnostic" && pair.Value is string) { result["diagnosticCodes"] = ErrorCodes((string)pair.Value); continue; }
                if (depth < 6 && new [] { "targets", "packages", "core", "result", "processes", "completionProof", "completionProofs", "host", "client", "stamp", "problem" }.Contains(pair.Key)) {
                    var child = pair.Value as IDictionary<string, object>;
                    var children = pair.Value as object[];
                    if (child != null) result[pair.Key] = Project(child, depth + 1);
                    else if (children != null) result[pair.Key] = children.Take(8).Select(item => Project(item, depth + 1)).ToArray();
                    continue;
                }
                if (!Keys.Contains(pair.Key)) continue;
                if (pair.Value == null || pair.Value is bool || pair.Value is int || pair.Value is long || pair.Value is double || pair.Value is decimal) result[pair.Key] = pair.Value;
                else if (pair.Value is string) {
                    string text = (string)pair.Value;
                    if (text.Length <= 240 && !text.Contains("\n")) result[pair.Key] = Clean(text);
                }
            }
            return result;
        }
        static string[] ErrorCodes(string line) {
            return Regex.Matches(Clean(line), @"\b(?:[A-Za-z]+Exception|[A-Za-z]*Error|ERR_[A-Z0-9_]+|UPDATE_[A-Z0-9_]+|GEA_[A-Z0-9_]+|EACCES|ENOENT|ENOSPC|ECONNRESET|ETIMEDOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b").Cast<Match>().Select(match => match.Value).Distinct().Take(16).ToArray();
        }
        internal static string StructuredText(string text) {
            object value = Json.DeserializeObject(text);
            var array = value as object[];
            if (array != null) return Json.Serialize(array.Select(item => Project(item)).Where(row => row.Count > 0).Take(100).ToArray());
            return Json.Serialize(Project(value));
        }
        internal static string TechnicalText(string text) {
            string trimmed = text.Trim();
            if (trimmed.StartsWith("{") || trimmed.StartsWith("[")) {
                try { return StructuredText(trimmed); } catch (ArgumentException) { }
            }
            var lines = new List<string>();
            foreach (string original in text.Replace("\r", "").Split('\n')) {
                string line = original.TrimEnd();
                line = Regex.Replace(line, @"^\s*\[(?:stdout|stderr|out|err|info|warn|error|debug|pnpm)\]\s*", "", RegexOptions.IgnoreCase);
                line = Regex.Replace(line, @"^\s*\[\d{4}-\d{2}-\d{2}[T ][0-9:.Z+-]+\]\s*", "");
                if (line.TrimStart().StartsWith("{")) {
                    try { string projected = StructuredText(line); if (projected != "{}") lines.Add(projected); } catch (ArgumentException) { lines.Add("[incomplete-structured-record]"); }
                    continue;
                }
                if (Regex.IsMatch(line, @"^(?:Progress: resolved \d+, reused \d+, downloaded \d+, added \d+(?:, done)?|Packages: [+-]\d+|Done in [0-9.msh ]+(?: using pnpm v[0-9.]+)?|Already up to date|Lockfile is up to date, resolution step is skipped)$")) lines.Add(line);
                else if (Regex.IsMatch(line, @"^\d{4}-\d{1,2}-\d{1,2}T[0-9:]+ \[GEA-INSTALL-DIAG\] pid=\d+ tickMs=\d+ errors=[01] [a-z][a-z0-9-]*(?: [A-Za-z]+=[0-9]+)*$")) lines.Add(line);
                else if (Regex.IsMatch(line, @"^(?:time: [0-9TZ:.+-]+|source: (?:host|web-boot|renderer|main)|phase: (?:startup|running)|app: (?:Synear GEA|GEA Desktop|DeepSeek Harness) [0-9A-Za-z.+-]+|platform: (?:win32|darwin|linux) (?:x64|arm64|ia32)|(?:electron|node): [0-9A-Za-z.+-]+|locale: [a-z]{2}(?:-[A-Z]{2})?|shell pid: [0-9]+)$")) lines.Add(Clean(line));
                else if (Regex.IsMatch(line, @"^\s+at\s+")) {
                    var frame = Regex.Match(line, @"^\s+at (?:(?<method>[A-Za-z_$<>][A-Za-z0-9_$.<>]{0,119}) \()?.*?(?<position>:\d+:\d+)\)?$");
                    if (frame.Success) lines.Add("at " + frame.Groups["method"].Value + " " + frame.Groups["position"].Value);
                }
                else {
                    line = Clean(line);
                    lines.AddRange(ErrorCodes(line));
                    if (line.IndexOf("Unexpected end of JSON", StringComparison.OrdinalIgnoreCase) >= 0) lines.Add("JSON_PARSE_TRUNCATED");
                    if (line.IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0) lines.Add("TIMEOUT");
                }
            }
            return String.Join(Environment.NewLine, lines);
        }
        internal static void Save(string path, object value) {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, Clean(Json.Serialize(value)), new System.Text.UTF8Encoding(false));
        }
        internal static string ReadBounded(string path, int maximum) {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("LINKED_SOURCE_SKIPPED");
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                int first = stream.ReadByte(), second = stream.ReadByte();
                bool unicode = first == 255 && second == 254 || first == 254 && second == 255;
                var encoding = unicode ? (first == 255 ? System.Text.Encoding.Unicode : System.Text.Encoding.BigEndianUnicode) : System.Text.Encoding.UTF8;
                long offset = Math.Max(0, stream.Length - maximum);
                if (unicode && offset % 2 != 0) offset++;
                stream.Seek(offset, SeekOrigin.Begin);
                using (var reader = new StreamReader(stream, encoding, true)) { if (offset > 0) reader.ReadLine(); return reader.ReadToEnd(); }
            }
        }
    }
}
