using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace GeaDiagnostics {
    internal static class Program {
        [STAThread]
        static int Main(string[] args) {
            try {
                if (args.Length == 4 && args[0] == "--probe" && args[2] == "--run") {
                    if (!Probe.Groups.Contains(args[1])) return 2;
                    string directory = Path.Combine(args[3], args[1] + "-data");
                    new Probe(CollectionPlan.Load(args[3]), args[1], directory).Run();
                    var files = Directory.GetFiles(directory).ToDictionary(Path.GetFileName, File.ReadAllText);
                    byte[] payload = new System.Text.UTF8Encoding(false).GetBytes(Privacy.Json.Serialize(files) + "\n");
                    using (var stdout = Console.OpenStandardOutput()) stdout.Write(payload, 0, payload.Length);
                    return 0;
                }
                string acceptance = args.Length >= 2 && args[0] == "--acceptance" ? args[1] : null;
                if (args.Contains("--headless") && acceptance != null) {
                    Collection.Collect(Collection.Create(acceptance), delegate {}, CancellationToken.None); return 0;
                }
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                bool created; string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
                using (var single = new Mutex(true, "Local\\GEA.Diagnostics." + sid, out created)) {
                    if (!created) { MessageBox.Show("日志采集工具已经打开，请使用原来的窗口。", "GEA日志采集", MessageBoxButtons.OK, MessageBoxIcon.Information); return 0; }
                    Application.Run(new DiagnosticWindow(acceptance));
                }
                return 0;
            } catch (Exception error) {
                if (args.Length > 0) { Console.Error.WriteLine(error.GetType().Name); return 1; }
                MessageBox.Show("日志采集工具未能启动。请保留文件，并将此情况告知技术支持。", "GEA日志采集", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
            }
        }
    }
    internal sealed class DiagnosticWindow : Form {
        readonly Label status = new Label();
        readonly Label detail = new Label();
        readonly ProgressBar progress = new ProgressBar();
        readonly Button primary = new Button();
        readonly Button secondary = new Button();
        readonly string acceptance;
        readonly CancellationTokenSource cancel = new CancellationTokenSource();
        CollectionResult result;
        bool busy = true;
        bool closeRequested;
        internal DiagnosticWindow(string value) {
            acceptance = value;
            Text = "GEA日志采集"; StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(650, 455); MinimumSize = new Size(610, 470);
            AutoScaleMode = AutoScaleMode.Dpi; Font = new Font("Microsoft YaHei UI", 10F); BackColor = Color.White; FormBorderStyle = FormBorderStyle.Sizable; MaximizeBox = false;
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(30), ColumnCount = 1, RowCount = 7 };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 54)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 12)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            root.Controls.Add(new Label { Text = "GEA日志采集", Font = new Font(Font.FontFamily, 20F, FontStyle.Bold), Dock = DockStyle.Fill, ForeColor = Color.FromArgb(155, 20, 33) }, 0, 0);
            root.Controls.Add(new Label { Text = "自动整理排障信息，完成后将日志包发给技术支持。\n仅收集技术信息，不修改系统或应用设置。", Dock = DockStyle.Fill, ForeColor = Color.FromArgb(65, 65, 65) }, 0, 1);
            var list = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 2, Padding = new Padding(0, 9, 0, 0) };
            list.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); list.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            string[] names = { "系统环境与软件版本", "客户端启动与崩溃", "安装与更新记录", "页面与接口错误", "Windows 相关事件", "进程与资源采样" };
            for (int index = 0; index < names.Length; index++) list.Controls.Add(new Label { Text = names[index], Dock = DockStyle.Fill, AutoSize = true, Padding = new Padding(0, 6, 0, 0) }, index % 2, index / 2);
            root.Controls.Add(list, 0, 2);
            status.Text = "正在准备收集。"; status.Dock = DockStyle.Fill; status.Font = new Font(Font, FontStyle.Bold); root.Controls.Add(status, 0, 3);
            progress.Dock = DockStyle.Fill; root.Controls.Add(progress, 0, 4);
            detail.Text = "无需选择日志目录。普通收集不需要管理员权限。"; detail.Dock = DockStyle.Fill; detail.Padding = new Padding(0, 9, 0, 0); detail.ForeColor = Color.FromArgb(80, 80, 80); root.Controls.Add(detail, 0, 5);
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 8, 0, 0) };
            primary.Text = "取消收集"; primary.AutoSize = true; primary.MinimumSize = new Size(112, 34); primary.Click += Primary;
            secondary.Text = "复制摘要"; secondary.AutoSize = true; secondary.MinimumSize = new Size(100, 34); secondary.Visible = false;
            secondary.Click += delegate { if (result != null) { try { Clipboard.SetText(result.Summary); detail.Text = "摘要已复制。请将日志包一起发给技术支持。"; } catch (System.Runtime.InteropServices.ExternalException) { detail.Text = "暂时无法复制，请直接发送生成的 ZIP 文件。"; } } };
            actions.Controls.Add(primary); actions.Controls.Add(secondary); root.Controls.Add(actions, 0, 6); Controls.Add(root);
            Shown += async delegate { await StartCollection(); };
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) { closeRequested = true; args.Cancel = true; cancel.Cancel(); primary.Enabled = false; status.Text = "正在停止收集，请稍候。"; } };
        }
        void Primary(object sender, EventArgs args) {
            if (busy) { cancel.Cancel(); primary.Enabled = false; status.Text = "正在停止收集，请稍候。"; }
            else if (result != null) {
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", "/select,\"" + result.Archive + "\"") { UseShellExecute = true }); }
                catch (System.ComponentModel.Win32Exception) { detail.Text = "无法打开文件夹，请到桌面查找生成的 GEA日志采集 ZIP。"; }
            }
            else Close();
        }
        static string ErrorCode(Exception error) { return error is IOException && Regex.IsMatch(error.Message, @"^[A-Z_]{4,60}$") ? error.Message : "REPORT_WRITE_FAILED"; }
        async Task StartCollection() {
            CollectionPlan plan = null;
            try {
                plan = Collection.Create(acceptance);
                result = await Task.Run(() => Collection.Collect(plan, delegate(string text, int percent) {
                    if (!IsDisposed) BeginInvoke(new Action(delegate { status.Text = text; progress.Value = Math.Max(0, Math.Min(100, percent)); }));
                }, cancel.Token));
                status.Text = "日志包已保存"; detail.Text = result.Partial ? "部分记录未获取，已在包内列明。请将 ZIP 发给技术支持。" : "请将生成的 ZIP 发给技术支持。";
                primary.Text = "打开文件夹"; primary.BackColor = Color.FromArgb(155, 20, 33); primary.ForeColor = Color.White; primary.FlatStyle = FlatStyle.Flat; secondary.Visible = true;
            } catch (OperationCanceledException) { if (plan != null) Privacy.Save(Path.Combine(plan.Run, "result.json"), new { status = "cancelled" }); status.Text = "已取消收集"; detail.Text = "本次没有生成日志包，应用和系统保持原状。"; primary.Text = "关闭"; }
            catch (Exception error) {
                status.Text = "日志包未能生成"; detail.Text = "请将故障时间告知技术支持。错误编号：" + (ErrorCode(error)); primary.Text = "关闭";
                if (plan != null) Privacy.Save(Path.Combine(plan.Run, "failure.json"), new { status = "failed", code = ErrorCode(error) });
            } finally { busy = false; primary.Enabled = true; if (closeRequested) Close(); }
        }
    }
}
