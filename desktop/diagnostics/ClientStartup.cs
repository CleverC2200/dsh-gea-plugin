using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Security.Principal;
using System.Text.RegularExpressions;

namespace GeaDiagnostics {
    internal sealed class ClientLaunch {
        public int pid;
        public int parentPid;
        public string role;
        public string startedUtc;
        public string executable;
        public string version;
        public string userDataDirectory;
    }
    internal static class ClientStartup {
        internal static string UserDataArgument(string command) {
            var match = Regex.Match(command ?? "", "(?:^|\\s)--user-data-dir(?:=|\\s+)(?:\"(?<path>[^\"]+)\"|(?<path>[^\\s]+))", RegexOptions.IgnoreCase);
            string path = match.Groups["path"].Value;
            return Path.IsPathRooted(path) && !path.StartsWith(@"\\", StringComparison.Ordinal) ? path : null;
        }
        internal static List<ClientLaunch> Read() {
            var launches = new List<ClientLaunch>();
            string sid = WindowsIdentity.GetCurrent().User.Value;
            using (var search = new ManagementObjectSearcher("SELECT Name,ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE Name='GEA Desktop.exe' OR Name='Synear GEA.exe'")) {
                search.Options.Timeout = TimeSpan.FromSeconds(3);
                foreach (ManagementObject row in search.Get()) using (row) {
                    using (var instance = new ManagementObject("Win32_Process.Handle='" + Convert.ToInt32(row["ProcessId"]) + "'"))
                    using (var owner = instance.InvokeMethod("GetOwnerSid", null, null)) if (owner == null || Convert.ToString(owner["Sid"]) != sid) continue;
                    string command = Convert.ToString(row["CommandLine"]), path = row["ExecutablePath"] as string;
                    string version = path != null && File.Exists(path) ? FileVersionInfo.GetVersionInfo(path).ProductVersion : null;
                    var type = Regex.Match(command, @"(?:^|\s)--type=(?<role>renderer|gpu-process|utility)(?:\s|$)");
                    launches.Add(new ClientLaunch { pid = Convert.ToInt32(row["ProcessId"]), parentPid = Convert.ToInt32(row["ParentProcessId"]), role = type.Success ? type.Groups["role"].Value : "main", startedUtc = ManagementDateTimeConverter.ToDateTime(Convert.ToString(row["CreationDate"])).ToUniversalTime().ToString("o"), executable = path, version = version, userDataDirectory = UserDataArgument(command) });
                }
            }
            return launches;
        }
        internal static IEnumerable<string> Roots(CollectionPlan plan, IEnumerable<ClientLaunch> launches) {
            return plan.AppRoots.Concat(launches.Select(row => row.userDataDirectory).Where(path => path != null)).Distinct(StringComparer.OrdinalIgnoreCase);
        }
    }
}
