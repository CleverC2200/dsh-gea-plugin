using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace GeaDiagnostics {
    internal sealed class ProbeStopException : IOException {
        internal ProbeStopException() : base("PROBE_STOP_UNCONFIRMED") { }
    }
    internal sealed class ProbeExecution {
        internal int ProcessId;
        internal int ExitCode;
        internal bool TimedOut;
    }
    internal sealed class OwnedJob : IDisposable {
        IntPtr handle;
        [StructLayout(LayoutKind.Sequential)] struct Basic { public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
        [StructLayout(LayoutKind.Sequential)] struct Io { public ulong read, write, other, readBytes, writeBytes, otherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic basic; public Io io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
        [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user, kernel, periodUser, periodKernel; public uint faults, total, active, terminated; }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint length, IntPtr returnedLength);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
        internal OwnedJob() {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new IOException("PROCESS_JOB_UNAVAILABLE");
            var limits = new Limits(); limits.basic.flags = 0x2000;
            IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(limits));
            try { Marshal.StructureToPtr(limits, data, false); if (!SetInformationJobObject(handle, 9, data, (uint)Marshal.SizeOf(limits))) { Dispose(); throw new IOException("PROCESS_JOB_SETUP_FAILED"); } }
            finally { Marshal.FreeHGlobal(data); }
        }
        internal void Add(Process process) {
            if (!AssignProcessToJobObject(handle, process.Handle)) throw new IOException("PROCESS_JOB_ASSIGN_FAILED");
        }
        internal void StopAndWait() {
            if (!TerminateJobObject(handle, 1)) throw new ProbeStopException();
            var clock = Stopwatch.StartNew();
            do {
                Accounting value;
                if (!QueryInformationJobObject(handle, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new ProbeStopException();
                if (value.active == 0) return;
                Thread.Sleep(20);
            } while (clock.Elapsed < TimeSpan.FromSeconds(5));
            throw new ProbeStopException();
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
    internal static class ProbeProcess {
        internal static ProbeExecution Run(ProcessStartInfo start, TimeSpan timeout, CancellationToken cancel) {
            cancel.ThrowIfCancellationRequested();
            bool started = false, assigned = false, timedOut = false;
            using (var job = new OwnedJob()) using (var process = new Process { StartInfo = start }) {
                try {
                    if (!process.Start()) throw new IOException("PROBE_START_FAILED");
                    started = true; job.Add(process); assigned = true;
                    var clock = Stopwatch.StartNew();
                    while (!process.WaitForExit(100)) {
                        if (cancel.IsCancellationRequested) break;
                        if (clock.Elapsed >= timeout) { timedOut = true; break; }
                    }
                } finally {
                    if (started && !assigned && !process.HasExited) process.Kill();
                    job.StopAndWait();
                    if (started && !process.WaitForExit(5000)) throw new ProbeStopException();
                }
                cancel.ThrowIfCancellationRequested();
                return new ProbeExecution { ProcessId = process.Id, ExitCode = process.ExitCode, TimedOut = timedOut };
            }
        }
    }
}
