using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class OrdinaryRunner {
    [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public int cb; public string reserved, desktop, title; public int x,y,width,height,charsX,charsY,fill,flags; public short show,reservedLength; public IntPtr reservedData,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,threadId; }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr existing,uint flags,uint disableCount,ref SidAttributes disable,uint deleteCount,IntPtr delete,uint restrictCount,IntPtr restrict,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int type,IntPtr information,uint length);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token,string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    static IntPtr Sid(string value) { var sid=new SecurityIdentifier(value); var bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);IntPtr result=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,result,bytes.Length);return result; }
    static void Check(bool result) { if(!result)throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static int Main(string[] args) {
        IntPtr original=IntPtr.Zero,token=IntPtr.Zero,admin=IntPtr.Zero,level=IntPtr.Zero;ProcessInfo child=new ProcessInfo();
        try {
            Check(OpenProcessToken(Process.GetCurrentProcess().Handle,0xF01FF,out original));admin=Sid("S-1-5-32-544");var disabled=new SidAttributes{sid=admin};
            Check(CreateRestrictedToken(original,1,1,ref disabled,0,IntPtr.Zero,0,IntPtr.Zero,out token));
            var medium=new SecurityIdentifier("S-1-16-8192");int size=Marshal.SizeOf(typeof(SidAttributes));level=Marshal.AllocHGlobal(size+medium.BinaryLength);var bytes=new byte[medium.BinaryLength];medium.GetBinaryForm(bytes,0);IntPtr pointer=IntPtr.Add(level,size);Marshal.Copy(bytes,0,pointer,bytes.Length);Marshal.StructureToPtr(new SidAttributes{sid=pointer,attributes=0x20},level,false);
            Check(SetTokenInformation(token,25,level,(uint)(size+bytes.Length)));
            var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup)),desktop="winsta0\\default"};string shell=Environment.GetEnvironmentVariable("SystemRoot")+"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
            string command="\""+shell+"\" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File \""+args[0]+"\" -Executable \""+args[1]+"\" -OutputDirectory \""+args[2]+"\"";
            Check(CreateProcessAsUser(token,shell,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x400,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out child));
            if(WaitForSingleObject(child.process,240000)!=0)throw new InvalidOperationException("ORDINARY_ACCEPTANCE_TIMEOUT");uint code;Check(GetExitCodeProcess(child.process,out code));return checked((int)code);
        } catch(Exception error) { Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1; }
        finally { if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);if(level!=IntPtr.Zero)Marshal.FreeHGlobal(level);if(admin!=IntPtr.Zero)Marshal.FreeHGlobal(admin);if(token!=IntPtr.Zero)CloseHandle(token);if(original!=IntPtr.Zero)CloseHandle(original); }
    }
}
