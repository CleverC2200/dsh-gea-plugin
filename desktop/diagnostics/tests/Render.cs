using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class RenderValidation {
    [STAThread]
    static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        string executable = args[0], output = args[1], mode = args[2]; Directory.CreateDirectory(output);
        string run = Path.Combine(Path.GetTempPath(), "GEA-ui-" + Guid.NewGuid().ToString("N"));
        if (mode == "failure") Directory.CreateDirectory(run);
        var assembly = Assembly.LoadFrom(executable);
        var type = assembly.GetType("GeaDiagnostics.DiagnosticWindow");
        var flags = BindingFlags.Instance | BindingFlags.NonPublic;
        var form = (Form)type.GetConstructor(flags, null, new [] { typeof(string) }, null).Invoke(new object[] { run });
        if (mode == "small") form.Size = form.MinimumSize;
        var status = (Label)type.GetField("status", flags).GetValue(form);
        var primary = (Button)type.GetField("primary", flags).GetValue(form);
        var timer = new Timer { Interval = 50 }; int ticks = 0, exit = 1;
        timer.Tick += delegate {
            ticks++;
            if (ticks == 1) { Capture(form, Path.Combine(output, mode + "-start.png")); if (mode == "cancel") primary.PerformClick(); else if (mode == "close") form.Close(); }
            if (!(bool)type.GetField("busy", flags).GetValue(form)) {
                Capture(form, Path.Combine(output, mode + "-end.png"));
                bool expected = mode == "cancel" ? status.Text == "已取消收集" : mode == "failure" ? status.Text == "日志包未能生成" : status.Text == "日志包已保存";
                File.WriteAllText(Path.Combine(output, mode + "-ui.txt"), "expected=" + expected + "\r\nstatus=" + status.Text + "\r\nbutton=" + primary.Text + "\r\nrun=" + run);
                exit = expected ? 0 : 1; timer.Stop(); form.Close();
            }
            if (ticks > 1000) { timer.Stop(); form.Close(); }
        };
        form.FormClosed += delegate { if (mode == "close") { bool stopped = !(bool)type.GetField("busy", flags).GetValue(form); File.WriteAllText(Path.Combine(output, mode + "-ui.txt"), "expected=" + stopped + "\r\nclosedAfterCollectionStopped=" + stopped); exit = stopped ? 0 : 1; } };
        form.Shown += delegate { timer.Start(); };
        Application.Run(form); timer.Dispose(); form.Dispose(); return exit;
    }
    static void Capture(Form form, string path) { using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(0, 0, bitmap.Width, bitmap.Height)); bitmap.Save(path); } }
}
