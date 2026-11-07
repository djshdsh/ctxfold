// ctxfold 桌面外壳 —— 原生 WinForms 窗口，不依赖浏览器。
//
// 结构：
//   Ui       配色/字体/控件工厂
//   Bridge   调内置后端（ctxfold.exe）的 JSON 接口
//   MainForm 主窗口（概览 / 提示词层 / 路由预览 / 维护）
//
// 编译（见 scripts/build-shell.mjs）：
//   csc /target:winexe /resource:dist\ctxfold.exe,ctxfold.exe /win32icon:build\ctxfold.ico
//
// 只用 C# 5 语法（Windows 自带 csc 只到 5.0）：不用 $"" / ?. / nameof / 表达式体成员。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

namespace CtxFold
{
    /** 圆角按钮：主按钮粉紫渐变，副按钮白底粉边，幽灵按钮只有字。 */
    internal sealed class SoftButton : Button
    {
        public bool Primary;
        public bool Ghost;
        public bool Active;
        public int Radius = 14;
        private bool hover;
        private bool press;

        public SoftButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            BackColor = Ui.Bg;
            Font = Ui.F(9.5f);
            Cursor = Cursors.Hand;
            Height = 34;
            UseVisualStyleBackColor = false;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; press = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { press = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { press = false; Invalidate(); base.OnMouseUp(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            using (SolidBrush bg = new SolidBrush(BackColor))
            {
                g.FillRectangle(bg, ClientRectangle);
            }
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = new Rectangle(1, 1, Width - 3, Height - 3);
            if (r.Width <= 0 || r.Height <= 0) return;
            int rad = Math.Min(Radius, r.Height / 2);
            using (GraphicsPath path = Ui.Round(r, rad))
            {
                if (!Ghost || Active)
                {
                    if (Primary)
                    {
                        Color a = press ? Ui.AccentDeep : Ui.Accent;
                        Color b = press ? Ui.AccentDeep : Ui.Accent2;
                        if (hover && !press) { a = Ui.AccentLite; b = Ui.Accent2Lite; }
                        using (LinearGradientBrush br = new LinearGradientBrush(
                            new Rectangle(r.X, r.Y, r.Width + 1, r.Height + 1), a, b, 20f))
                        {
                            g.FillPath(br, path);
                        }
                        using (Pen glow = new Pen(Color.FromArgb(40, 255, 120, 170)))
                        {
                            g.DrawPath(glow, path);
                        }
                    }
                    else
                    {
                        Color fill = hover ? Ui.AccentSoft : Color.White;
                        if (Active) fill = Ui.AccentSoft;
                        using (SolidBrush b = new SolidBrush(fill))
                        {
                            g.FillPath(b, path);
                        }
                        using (Pen pen = new Pen(hover || Active ? Ui.Accent : Ui.Border))
                        {
                            g.DrawPath(pen, path);
                        }
                    }
                }
            }
            Color fc;
            if (Primary) fc = Color.White;
            else if (Active) fc = Ui.AccentDeep;
            else if (Ghost) fc = hover ? Ui.Accent : Ui.Muted;
            else fc = hover ? Ui.AccentDeep : Ui.Text;
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, fc,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    /** 粉色胶囊开关，替掉系统那个蓝色小方框。 */
    internal sealed class SoftCheck : CheckBox
    {
        private bool hover;

        public SoftCheck()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Ui.Bg;
            ForeColor = Ui.Text;
            Font = Ui.F(9.5f);
            AutoSize = false;
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            using (SolidBrush bg = new SolidBrush(BackColor))
            {
                g.FillRectangle(bg, ClientRectangle);
            }
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int h = 20;
            int w = 36;
            int top = (Height - h) / 2;
            Rectangle track = new Rectangle(0, top, w, h);
            Color fill = Checked ? Ui.Accent : Color.FromArgb(0xF0, 0xE2, 0xEA);
            if (hover && !Checked) fill = Color.FromArgb(0xE8, 0xD5, 0xE1);
            using (GraphicsPath p = Ui.Round(track, h / 2))
            using (SolidBrush b = new SolidBrush(fill))
            {
                g.FillPath(b, p);
            }
            int kd = h - 6;
            int kx = Checked ? w - kd - 3 : 3;
            using (SolidBrush b = new SolidBrush(Color.White))
            {
                g.FillEllipse(b, kx, top + 3, kd, kd);
            }
            Rectangle text = new Rectangle(w + 10, 0, Width - w - 12, Height);
            TextRenderer.DrawText(g, Text, Font, text, hover ? Ui.AccentDeep : ForeColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    /** 圆角卡片：白色底 + 柔和投影 + 1px 粉边。 */
    internal sealed class RoundedPanel : Panel
    {
        public int Radius = 18;
        public Color Fill = Color.White;
        public Color Canvas = Ui.Bg;
        public Color Stroke = Ui.Bg;
        public bool Shadow = true;

        public RoundedPanel()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Ui.Bg;
            Stroke = Ui.Border;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            using (SolidBrush canvas = new SolidBrush(Canvas))
            {
                g.FillRectangle(canvas, ClientRectangle);
            }
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (Width < 6 || Height < 6) return;
            Rectangle r = new Rectangle(1, 1, Width - 3, Height - 3);
            if (Shadow)
            {
                for (int i = 3; i >= 1; i--)
                {
                    Rectangle sr = new Rectangle(r.X - i + 1, r.Y + i, r.Width + i * 2 - 2, r.Height + i * 2 - 2);
                    using (GraphicsPath sp = Ui.Round(sr, Radius + i))
                    using (SolidBrush sb = new SolidBrush(Color.FromArgb(6, 0xB4, 0x74, 0x96)))
                    {
                        g.FillPath(sb, sp);
                    }
                }
            }
            using (GraphicsPath path = Ui.Round(r, Radius))
            using (SolidBrush b = new SolidBrush(Fill))
            {
                g.FillPath(b, path);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (Stroke.A > 0 && Width > 6 && Height > 6)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Rectangle r = new Rectangle(1, 1, Width - 3, Height - 3);
                using (GraphicsPath path = Ui.Round(r, Radius))
                using (Pen pen = new Pen(Stroke))
                {
                    e.Graphics.DrawPath(pen, path);
                }
            }
        }
    }

    /** 渐变背景：奶油粉 → 淡藕荷，带两团柔光。 */
    internal sealed class GradientPanel : Panel
    {
        public GradientPanel()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Ui.Bg;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Rectangle r = ClientRectangle;
            if (r.Width <= 0 || r.Height <= 0) return;
            using (LinearGradientBrush br = new LinearGradientBrush(
                new Rectangle(0, 0, r.Width + 1, r.Height + 1), Ui.Bg, Ui.BgAlt, 32f))
            {
                g.FillRectangle(br, r);
            }
            Blob(g, r.Width * 0.86f, r.Height * 0.06f, r.Width * 0.62f, Color.FromArgb(60, 0xFF, 0xB6, 0xD2));
            Blob(g, r.Width * 0.08f, r.Height * 0.96f, r.Width * 0.58f, Color.FromArgb(52, 0xD3, 0xBC, 0xFF));
        }

        private static void Blob(Graphics g, float cx, float cy, float d, Color c)
        {
            if (d < 4) return;
            RectangleF rc = new RectangleF(cx - d / 2f, cy - d / 2f, d, d);
            using (GraphicsPath p = new GraphicsPath())
            {
                p.AddEllipse(rc);
                using (PathGradientBrush br = new PathGradientBrush(p))
                {
                    br.CenterColor = Color.FromArgb(c.A, c);
                    br.SurroundColors = new Color[] { Color.FromArgb(0, c) };
                    g.FillEllipse(br, rc);
                }
            }
        }
    }

    internal static class Ui
    {
        // 粉白主题
        public static readonly Color Bg = Color.FromArgb(0xFF, 0xF2, 0xF8);
        public static readonly Color BgAlt = Color.FromArgb(0xF6, 0xEC, 0xFF);
        public static readonly Color Card = Color.White;
        public static readonly Color Field = Color.FromArgb(0xFF, 0xF8, 0xFC);
        public static readonly Color Border = Color.FromArgb(0xF6, 0xD6, 0xE5);
        public static readonly Color Text = Color.FromArgb(0x4B, 0x3A, 0x45);
        public static readonly Color Muted = Color.FromArgb(0x9E, 0x88, 0x96);
        public static readonly Color Accent = Color.FromArgb(0xFF, 0x85, 0xB2);
        public static readonly Color AccentLite = Color.FromArgb(0xFF, 0x9C, 0xC2);
        public static readonly Color AccentDeep = Color.FromArgb(0xF2, 0x6C, 0x9C);
        public static readonly Color Accent2 = Color.FromArgb(0xC2, 0x8F, 0xF0);
        public static readonly Color Accent2Lite = Color.FromArgb(0xD2, 0xA8, 0xF7);
        public static readonly Color AccentSoft = Color.FromArgb(0xFF, 0xE4, 0xF0);
        public static readonly Color Ok = Color.FromArgb(0x4F, 0xB0, 0x86);
        public static readonly Color Warn = Color.FromArgb(0xE0, 0x93, 0x3C);
        public static readonly Color Danger = Color.FromArgb(0xDC, 0x63, 0x83);

        public static readonly string Face = "Microsoft YaHei UI";
        public static readonly string Mono = "Consolas";

        public static Font F(float size)
        {
            return new Font(Face, size, FontStyle.Regular, GraphicsUnit.Point);
        }

        public static Font FB(float size)
        {
            return new Font(Face, size, FontStyle.Bold, GraphicsUnit.Point);
        }

        public static Font M(float size)
        {
            return new Font(Mono, size, FontStyle.Regular, GraphicsUnit.Point);
        }

        public static GraphicsPath Round(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = Math.Max(2, Math.Min(radius * 2, Math.Min(r.Width, r.Height)));
            if (d <= 2)
            {
                p.AddRectangle(r);
                return p;
            }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static Label Lab(string text, Font font, Color color)
        {
            Label l = new Label();
            l.Text = text;
            l.Font = font;
            l.ForeColor = color;
            l.BackColor = Color.Transparent;
            l.AutoSize = false;
            l.TextAlign = ContentAlignment.MiddleLeft;
            return l;
        }

        public static Button Btn(string text, bool primary)
        {
            SoftButton b = new SoftButton();
            b.Text = text;
            b.Primary = primary;
            b.Width = 120;
            b.Height = 34;
            return b;
        }

        /** 只有文字的按钮，用来做页签。 */
        public static Button Pill(string text, bool active)
        {
            SoftButton b = new SoftButton();
            b.Text = text;
            b.Ghost = false;
            b.Font = active ? FB(10f) : F(10f);
            b.Height = 36;
            b.Width = 104;
            b.Radius = 18;
            return b;
        }

        /** 圆角卡片，标题与正文两个 Label 由 out 返回。 */
        public static Panel CardBox(string title, out Label body)
        {
            RoundedPanel p = new RoundedPanel();
            p.Radius = 18;
            Label t = Lab(title, F(9f), Muted);
            t.Dock = DockStyle.Top;
            t.Height = 24;
            t.Padding = new Padding(14, 8, 12, 0);
            body = Lab("", FB(12.5f), Text);
            body.Dock = DockStyle.Fill;
            body.TextAlign = ContentAlignment.TopLeft;
            body.Padding = new Padding(14, 2, 14, 12);
            p.Controls.Add(body);
            p.Controls.Add(t);
            return p;
        }

        /** 递归把所有子控件收拾一遍。 */
        public static void StyleAll(Control root)
        {
            foreach (Control c in root.Controls)
            {
                StyleControl(c);
                StyleAll(c);
            }
        }

        /** 读取内嵌头像；没有资源就返回 null，页头自动退回纯文字。 */
        public static Image LoadAvatar()
        {
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                string[] names = asm.GetManifestResourceNames();
                for (int i = 0; i < names.Length; i++)
                {
                    if (names[i] == "avatar.png" || names[i].EndsWith("avatar.png"))
                    {
                        using (Stream s = asm.GetManifestResourceStream(names[i]))
                        {
                            if (s == null) return null;
                            using (Image raw = Image.FromStream(s))
                            {
                                return new Bitmap(raw);
                            }
                        }
                    }
                }
            }
            catch
            {
            }
            return null;
        }

        /** 把矩形图片裁成圆形，放进 PictureBox。 */
        public static void MakeRound(PictureBox pic)
        {
            if (pic == null || pic.Image == null || pic.Width < 4) return;
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddEllipse(0, 0, pic.Width - 1, pic.Height - 1);
                pic.Region = new Region(path);
            }
        }

        /** 统一收拾列表/输入控件的观感。 */
        public static void StyleControl(Control c)
        {
            ListView lv = c as ListView;
            if (lv != null)
            {
                lv.BorderStyle = BorderStyle.None;
                lv.BackColor = Card;
                lv.ForeColor = Text;
                lv.Font = F(9.5f);
                lv.HeaderStyle = ColumnHeaderStyle.Nonclickable;
                lv.GridLines = false;
                lv.FullRowSelect = true;
                lv.OwnerDraw = true;
                lv.DrawColumnHeader += delegate(object s, DrawListViewColumnHeaderEventArgs e)
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(0xFF, 0xF3, 0xF8)))
                    {
                        e.Graphics.FillRectangle(b, e.Bounds);
                    }
                    using (SolidBrush b = new SolidBrush(Muted))
                    {
                        e.Graphics.DrawString(e.Header.Text, FB(9f), b,
                            new RectangleF(e.Bounds.X + 8, e.Bounds.Y + 6, e.Bounds.Width - 8, e.Bounds.Height));
                    }
                };
                lv.DrawItem += delegate(object s, DrawListViewItemEventArgs e) { e.DrawDefault = false; };
                lv.DrawSubItem += delegate(object s, DrawListViewSubItemEventArgs e)
                {
                    Color back = (e.ItemIndex % 2 == 0) ? Card : Color.FromArgb(0xFF, 0xFB, 0xFD);
                    if (e.Item.Selected) back = AccentSoft;
                    using (SolidBrush b = new SolidBrush(back))
                    {
                        e.Graphics.FillRectangle(b, e.Bounds);
                    }
                    Color fg = e.ColumnIndex == 0 ? Text : Muted;
                    using (SolidBrush b = new SolidBrush(fg))
                    {
                        e.Graphics.DrawString(e.SubItem.Text, F(9.5f), b,
                            new RectangleF(e.Bounds.X + 8, e.Bounds.Y + 4, e.Bounds.Width - 10, e.Bounds.Height));
                    }
                };
                return;
            }
            ComboBox cmb = c as ComboBox;
            if (cmb != null)
            {
                cmb.FlatStyle = FlatStyle.Flat;
                cmb.BackColor = Field;
                cmb.ForeColor = Text;
                cmb.Font = F(9.5f);
                return;
            }
            RichTextBox rtb = c as RichTextBox;
            if (rtb != null)
            {
                rtb.BackColor = Field;
                rtb.ForeColor = Text;
                rtb.BorderStyle = BorderStyle.None;
                return;
            }
            TextBox tb = c as TextBox;
            if (tb != null)
            {
                tb.BackColor = Field;
                tb.ForeColor = Text;
                tb.BorderStyle = BorderStyle.None;
            }
        }
    }

    internal static class Bridge
    {
        private static string exePath;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        public static string BackendPath()
        {
            if (exePath != null) return exePath;
            string stamp = Assembly.GetExecutingAssembly().GetName().Version.ToString();
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Path.Combine("ctxfold", Path.Combine("runtime", stamp)));
            string target = Path.Combine(dir, "ctxfold.exe");
            Directory.CreateDirectory(dir);
            Assembly asm = Assembly.GetExecutingAssembly();
            Stream src = asm.GetManifestResourceStream("ctxfold.exe");
            if (src == null)
            {
                throw new InvalidOperationException("内置后端缺失：编译时没有嵌入 ctxfold.exe");
            }
            using (src)
            {
                bool need = true;
                if (File.Exists(target)) need = new FileInfo(target).Length != src.Length;
                if (need)
                {
                    string tmp = target + ".tmp";
                    using (FileStream dst = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        src.CopyTo(dst);
                    }
                    if (File.Exists(target)) File.Delete(target);
                    File.Move(tmp, target);
                }
            }
            exePath = target;
            PruneOldRuntimes(Path.GetDirectoryName(dir), stamp);
            return target;
        }

        /** 只留当前版本的后端目录，旧版本的运行目录全部清掉。 */
        private static void PruneOldRuntimes(string runtimeRoot, string keep)
        {
            try
            {
                if (runtimeRoot == null || !Directory.Exists(runtimeRoot)) return;
                foreach (string d in Directory.GetDirectories(runtimeRoot))
                {
                    string name = Path.GetFileName(d);
                    if (string.Equals(name, keep, StringComparison.OrdinalIgnoreCase)) continue;
                    Version parsed;
                    // 只清旧版外壳目录（纯数字版本号）；后端自己的资产目录名字带后缀，别动它
                    if (!Version.TryParse(name, out parsed)) continue;
                    try { Directory.Delete(d, true); }
                    catch (Exception) { }
                }
            }
            catch (Exception) { }
        }

        public static Dictionary<string, object> Call(string action, Dictionary<string, object> args)
        {
            Dictionary<string, object> bad = new Dictionary<string, object>();
            try
            {
                string exe = BackendPath();
                string payload = Json.Serialize(args == null ? new Dictionary<string, object>() : args);
                string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(payload));
                ProcessStartInfo psi = new ProcessStartInfo(exe);
                psi.Arguments = "bridge " + action + " " + b64;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                using (Process p = Process.Start(psi))
                {
                    string stdout = p.StandardOutput.ReadToEnd();
                    string stderr = p.StandardError.ReadToEnd();
                    p.WaitForExit();
                    if (stdout == null || stdout.Trim().Length == 0)
                    {
                        bad["ok"] = false;
                        bad["error"] = "后端没有返回内容（exit " + p.ExitCode + "）\n" + (stderr == null ? "" : stderr.Trim());
                        return bad;
                    }
                    Dictionary<string, object> res =
                        Json.Deserialize<Dictionary<string, object>>(stdout.Trim()) as Dictionary<string, object>;
                    if (res == null)
                    {
                        bad["ok"] = false;
                        bad["error"] = "后端返回了无法识别的内容";
                        return bad;
                    }
                    return res;
                }
            }
            catch (Exception ex)
            {
                bad["ok"] = false;
                bad["error"] = ex.Message;
                return bad;
            }
        }

        public static bool Ok(Dictionary<string, object> r)
        {
            object v;
            if (r == null || !r.TryGetValue("ok", out v) || v == null) return false;
            return Convert.ToBoolean(v);
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return null;
            return v as Dictionary<string, object>;
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return "";
            return Convert.ToString(v);
        }

        public static int Num(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToInt32(v); }
            catch { return 0; }
        }

        public static bool Flag(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return false;
            try { return Convert.ToBoolean(v); }
            catch { return false; }
        }

        /** 数组字段的条数；数字字段原样返回。 */
        public static int Count(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return 0;
            IEnumerable seq = v as IEnumerable;
            if (seq == null) return Num(d, key);
            int n = 0;
            foreach (object o in seq) n++;
            return n;
        }

        public static IEnumerable<object> Items(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) yield break;
            IEnumerable seq = v as IEnumerable;
            if (seq == null) yield break;
            foreach (object o in seq) yield return o;
        }
    }

    /** 桌面快捷方式（IDispatch 晚期绑定 WScript.Shell，避免加 COM 引用）。 */
    internal static class Shortcut
    {
        public static string LinkPath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "ctxfold.lnk");
        }

        public static bool Create()
        {
            try
            {
                string lnk = LinkPath();
                object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                object sc = shell.GetType().InvokeMember("CreateShortcut",
                    BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                Type t = sc.GetType();
                t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc,
                    new object[] { Application.ExecutablePath });
                t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc,
                    new object[] { Path.GetDirectoryName(Application.ExecutablePath) });
                t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc,
                    new object[] { Application.ExecutablePath + ",0" });
                t.InvokeMember("Description", BindingFlags.SetProperty, null, sc,
                    new object[] { "AI 破甲 · ctxfold 提示词控制台" });
                t.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private Panel content;
        private Panel tabBar;
        private Panel tabIndicator;
        private Panel[] pages;
        private Button[] tabBtns;
        private int activeTab;
        private static readonly string[] TabNames = new string[] { "一键注入", "概览", "提示词层", "路由预览", "维护" };

        private ComboBox cmbTarget;
        private CheckBox chkTakeover;
        private Button btnInject, btnReinject;
        private RichTextBox rtbInject;
        private Label labChannel;
        private Label labOverride, labSanitize;
        private Label labRoute;
        private ListView lvDoctor, lvLayers, lvPatches;
        private TextBox txtLayer, txtRoute;
        private RichTextBox rtbPreview;
        private CheckBox chkEnabled, chkRouting;
        private ComboBox cmbApproval;
        private ToolStripStatusLabel labStatus;
        private ToolStripProgressBar bar;
        private string currentLayer = "";
        private bool loadingOptions;
        private bool injectInit;
        private string initialHome = "";
        private Dictionary<string, object> pendingReceipt;

        public MainForm(string initialHome)
        {
            this.initialHome = initialHome == null ? "" : initialHome;
            Text = "AI 破甲 · ctxfold 提示词控制台";
            BackColor = Ui.Bg;
            ForeColor = Ui.Text;
            Font = Ui.F(9.5f);
            ClientSize = new Size(1020, 720);
            MinimumSize = new Size(900, 620);
            DoubleBuffered = true;
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { }

            BuildMenu();
            BuildBody();
            BuildStatus();
            Ui.StyleAll(this);
            // 停靠按 z-order 从外到内：让菜单条压在最外层，否则标签栏会盖住菜单
            if (MainMenuStrip != null) Controls.SetChildIndex(MainMenuStrip, Controls.Count - 1);

            Shown += delegate { RefreshAll(); };
        }

        // ---------- 外壳骨架 ----------

        private void BuildMenu()
        {
            MenuStrip menu = new MenuStrip();
            menu.BackColor = Ui.Card;
            menu.ForeColor = Ui.Text;
            menu.Renderer = new FlatMenu();
            ToolStripMenuItem file = new ToolStripMenuItem("文件");
            ToolStripMenuItem quit = new ToolStripMenuItem("退出");
            quit.Click += delegate { Close(); };
            file.DropDownItems.Add(quit);
            ToolStripMenuItem act = new ToolStripMenuItem("操作");
            ToolStripMenuItem refresh = new ToolStripMenuItem("刷新");
            refresh.Click += delegate { RefreshAll(); };
            ToolStripMenuItem clean = new ToolStripMenuItem("清洗并接管");
            clean.Click += delegate { DoClean(); };
            ToolStripMenuItem restore = new ToolStripMenuItem("还原提示词");
            restore.Click += delegate { DoRestore(); };
            ToolStripMenuItem shortcut = new ToolStripMenuItem("在桌面放一个快捷方式");
            shortcut.Click += delegate { MakeShortcut(); };
            act.DropDownItems.Add(refresh);
            act.DropDownItems.Add(new ToolStripSeparator());
            act.DropDownItems.Add(clean);
            act.DropDownItems.Add(restore);
            act.DropDownItems.Add(new ToolStripSeparator());
            act.DropDownItems.Add(shortcut);
            ToolStripMenuItem help = new ToolStripMenuItem("帮助");
            ToolStripMenuItem about = new ToolStripMenuItem("关于");
            about.Click += delegate
            {
                MessageBox.Show(this,
                    "ctxfold 1.0\n\nPi Agent 提示词控制台\n注入 / 裁剪 / 清洗 / 接管，全部在本机完成。",
                    "关于 ctxfold", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };
            help.DropDownItems.Add(about);
            menu.Items.Add(file);
            menu.Items.Add(act);
            menu.Items.Add(help);
            MainMenuStrip = menu;
            Controls.Add(menu);
        }

        private void BuildBody()
        {
            content = new Panel();
            content.Dock = DockStyle.Fill;
            content.BackColor = Ui.Bg;

            pages = new Panel[]
            {
                BuildInject(),
                BuildOverview(),
                BuildLayers(),
                BuildPreview(),
                BuildMaintenance(),
            };
            foreach (Panel page in pages)
            {
                page.Dock = DockStyle.Fill;
                page.Visible = false;
                content.Controls.Add(page);
            }

            tabBar = new Panel();
            tabBar.Dock = DockStyle.Top;
            tabBar.Height = 52;
            tabBar.BackColor = Ui.Bg;

            tabBtns = new Button[pages.Length];
            for (int i = 0; i < pages.Length; i++)
            {
                int index = i;
                SoftButton b = (SoftButton)Ui.Pill(TabNames[i], i == 0);
                b.AccessibleName = "tab:" + TabNames[i];
                b.Left = 18 + i * 112;
                b.Top = 10;
                b.TabStop = false;
                b.Click += delegate { SelectTab(index); };
                tabBar.Controls.Add(b);
                tabBtns[i] = b;
            }

            tabIndicator = new Panel();
            tabIndicator.Visible = false;
            tabBar.Controls.Add(tabIndicator);

            Controls.Add(content);
            Controls.Add(tabBar);
            SelectTab(0);
        }

        /** 切页：只切可见性，不重建页面，避免丢掉正在编辑的内容。 */
        private void SelectTab(int index)
        {
            if (pages == null) return;
            activeTab = index;
            for (int i = 0; i < pages.Length; i++)
            {
                pages[i].Visible = i == index;
                SoftButton sb = tabBtns[i] as SoftButton;
                if (sb != null)
                {
                    sb.Active = i == index;
                    sb.Font = i == index ? Ui.FB(10f) : Ui.F(10f);
                    sb.Invalidate();
                }
            }
            pages[index].BringToFront();
        }

        private void BuildStatus()
        {
            StatusStrip st = new StatusStrip();
            st.BackColor = Color.FromArgb(0xFF, 0xF7, 0xFB);
            st.ForeColor = Ui.Muted;
            st.SizingGrip = false;
            st.Padding = new Padding(10, 0, 10, 2);
            labStatus = new ToolStripStatusLabel("就绪");
            labStatus.ForeColor = Ui.Muted;
            bar = new ToolStripProgressBar();
            bar.Style = ProgressBarStyle.Marquee;
            bar.Visible = false;
            bar.Width = 120;
            st.Items.Add(labStatus);
            st.Items.Add(bar);
            Controls.Add(st);
        }

        // ---------- 一键注入 ----------

        private Panel BuildInject()
        {
            Panel page = new Panel();
            page.BackColor = Ui.Bg;
            page.Padding = new Padding(22, 16, 22, 18);

            Panel head = new Panel();
            head.Dock = DockStyle.Top;
            head.Height = 78;
            head.BackColor = Ui.Bg;

            PictureBox avatar = new PictureBox();
            avatar.Image = Ui.LoadAvatar();
            avatar.SizeMode = PictureBoxSizeMode.Zoom;
            avatar.Width = 62;
            avatar.Height = 62;
            avatar.Left = 0;
            avatar.Top = 4;
            avatar.BackColor = Ui.Bg;
            head.Controls.Add(avatar);
            Ui.MakeRound(avatar);

            Label title = Ui.Lab("ctxfold", Ui.FB(19f), Ui.Text);
            title.Left = 78;
            title.Top = 6;
            title.Width = 420;
            title.Height = 32;
            Label sub = Ui.Lab("把插件装进本机的 Pi Agent，点一下就完事。", Ui.F(9.5f), Ui.Muted);
            sub.Left = 79;
            sub.Top = 40;
            sub.Width = 560;
            sub.Height = 22;
            head.Controls.Add(title);
            head.Controls.Add(sub);

            RoundedPanel act = new RoundedPanel();
            act.Dock = DockStyle.Top;
            act.Height = 178;
            act.Radius = 20;
            act.Fill = Color.White;

            Label labTarget = Ui.Lab("目标 Pi Agent 目录", Ui.F(9f), Ui.Muted);
            labTarget.Left = 16;
            labTarget.Top = 12;
            labTarget.Width = 200;

            cmbTarget = new ComboBox();
            cmbTarget.Left = 16;
            cmbTarget.Top = 34;
            cmbTarget.Width = 560;
            cmbTarget.DropDownStyle = ComboBoxStyle.DropDown;
            cmbTarget.FlatStyle = FlatStyle.Flat;
            cmbTarget.BackColor = Ui.Field;
            cmbTarget.ForeColor = Ui.Text;
            cmbTarget.Font = Ui.M(9.5f);

            Button scan = Ui.Btn("重新扫描", false);
            scan.Left = 588;
            scan.Top = 33;
            scan.Width = 96;
            scan.Click += delegate { ScanTargets(); };

            chkTakeover = new SoftCheck();
            chkTakeover.Text = "同时清洗原有提示词，并完全接管系统提示词";
            chkTakeover.ForeColor = Ui.Text;
            chkTakeover.Font = Ui.F(9f);
            chkTakeover.AutoSize = false;
            chkTakeover.Width = 400;
            chkTakeover.Height = 26;
            chkTakeover.Left = 18;
            chkTakeover.Top = 72;

            btnInject = Ui.Btn("一键注入", true);
            btnInject.Left = 16;
            btnInject.Top = 100;
            btnInject.Width = 190;
            btnInject.Height = 46;
            btnInject.Font = Ui.FB(11f);
            btnInject.Click += delegate { DoInject(false); };

            btnReinject = Ui.Btn("只更新文件", false);
            btnReinject.Left = 216;
            btnReinject.Top = 100;
            btnReinject.Width = 130;
            btnReinject.Height = 46;
            btnReinject.Click += delegate { DoInject(true); };

            Label hint = Ui.Lab("装完新开一个 pi 会话就生效；已经在跑的会话要重开。", Ui.F(9f), Ui.Muted);
            hint.Left = 360;
            hint.Top = 116;
            hint.Width = 460;

            act.Controls.Add(labTarget);
            act.Controls.Add(cmbTarget);
            act.Controls.Add(scan);
            act.Controls.Add(chkTakeover);
            act.Controls.Add(btnInject);
            act.Controls.Add(btnReinject);
            act.Controls.Add(hint);

            rtbInject = new RichTextBox();
            rtbInject.Dock = DockStyle.Fill;
            rtbInject.ReadOnly = true;
            rtbInject.BorderStyle = BorderStyle.None;
            rtbInject.BackColor = Ui.Field;
            rtbInject.ForeColor = Ui.Text;
            rtbInject.Font = Ui.M(9.5f);
            rtbInject.WordWrap = true;

            RoundedPanel wrap = new RoundedPanel();
            wrap.Dock = DockStyle.Fill;
            wrap.Radius = 16;
            wrap.Fill = Ui.Field;
            wrap.Shadow = false;
            wrap.Padding = new Padding(14, 12, 14, 12);
            wrap.Controls.Add(rtbInject);

            Panel bottom = new Panel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = 58;
            bottom.BackColor = Ui.Bg;
            Button openHome = Ui.Btn("打开主目录", false);
            openHome.Width = 120;
            openHome.Left = 0;
            openHome.Top = 12;
            openHome.Click += delegate { OpenPath("home"); };
            Button uninstall = Ui.Btn("从 Pi Agent 卸载", false);
            uninstall.Width = 140;
            uninstall.Left = 130;
            uninstall.Top = 12;
            uninstall.Click += delegate { DoUninstall(); };
            bottom.Controls.Add(openHome);
            bottom.Controls.Add(uninstall);

            Panel gap1 = new Panel();
            gap1.Dock = DockStyle.Top;
            gap1.Height = 14;
            gap1.BackColor = Ui.Bg;
            Panel gap2 = new Panel();
            gap2.Dock = DockStyle.Top;
            gap2.Height = 14;
            gap2.BackColor = Ui.Bg;

            page.Controls.Add(wrap);
            page.Controls.Add(bottom);
            page.Controls.Add(gap2);
            page.Controls.Add(act);
            page.Controls.Add(gap1);
            page.Controls.Add(head);
            return page;
        }

        // ---------- 一键注入：动作 ----------

        private void ScanTargets()
        {
            Run("扫描 Pi Agent 目录…",
                delegate { return Bridge.Call("targets", null); },
                delegate(Dictionary<string, object> r) { FillTargets(r); });
        }

        private void FillTargets(Dictionary<string, object> r)
        {
            Dictionary<string, object> body = Bridge.Obj(r, "data");
            if (body == null) return;
            string keep = cmbTarget.Text;
            string def = Bridge.Str(body, "defaultHome");
            cmbTarget.BeginUpdate();
            cmbTarget.Items.Clear();
            foreach (object o in Bridge.Items(body, "targets"))
            {
                Dictionary<string, object> t = o as Dictionary<string, object>;
                if (t == null) continue;
                string p = Bridge.Str(t, "path");
                if (p.Length > 0) cmbTarget.Items.Add(p);
            }
            cmbTarget.EndUpdate();
            if (keep.Length > 0) cmbTarget.Text = keep;
            else if (def.Length > 0) cmbTarget.Text = def;
            else if (cmbTarget.Items.Count > 0) cmbTarget.SelectedIndex = 0;
        }

        private void DoInject(bool onlyFiles)
        {
            string target = (cmbTarget.Text ?? "").Trim();
            if (target.Length == 0)
            {
                labStatus.Text = "先选一个目标目录";
                return;
            }
            bool takeover = chkTakeover.Checked && !onlyFiles;
            Dictionary<string, object> args = new Dictionary<string, object>();
            args["home"] = target;
            args["force"] = true;
            args["clean"] = takeover;
            args["override"] = takeover;
            Run(takeover ? "注入并接管…" : "写入文件…",
                delegate { return Bridge.Call("inject", args); },
                delegate(Dictionary<string, object> r)
                {
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    if (body == null)
                    {
                        rtbInject.Text = "注入失败：" + Bridge.Str(r, "error");
                        labStatus.Text = "注入失败";
                        return;
                    }
                    RenderInjectResult(body);
                    labStatus.Text = "注入完成 → " + Bridge.Str(body, "home");
                    pendingReceipt = body;
                    RefreshAll();
                });
        }

        /** 注入完成后的详细回执。 */
        private void RenderInjectResult(Dictionary<string, object> body)
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("注入完成 → " + Bridge.Str(body, "home"));
            sb.AppendLine();
            int copied = Bridge.Count(body, "copied");
            sb.AppendLine("写入文件　" + copied + " 个（扩展 + 7 层提示词 + 规则集 + 技能包）");
            sb.AppendLine("注入通道　" + Bridge.Str(body, "channel"));
            sb.AppendLine("层　　　　" + Bridge.Str(body, "layers"));
            sb.AppendLine("体量　　　全量 " + Bridge.Num(body, "fullChars") + " 字符");
            sb.AppendLine("完全接管　" + (Bridge.Flag(body, "override") ? "开（系统提示词整条由 ctxfold 提供）" : "关（与 Pi 内置提示词共存）"));
            Dictionary<string, object> cleaned = Bridge.Obj(body, "cleaned");
            if (cleaned != null)
            {
                Dictionary<string, object> files = Bridge.Obj(cleaned, "data") ?? cleaned;
                int n = Bridge.Count(files, "files");
                if (n > 0) sb.AppendLine("清洗　　　清空 " + n + " 个提示词文件，原文件已备份");
            }
            int failed = Bridge.Num(body, "failed");
            sb.AppendLine("自检　　　" + (failed == 0 ? "全部通过" : failed + " 项没过，看「概览」页"));
            sb.AppendLine();
            sb.AppendLine("下一步：新开一个 pi 会话就生效。");
            rtbInject.Text = sb.ToString();
        }

        /** 刷新时把当前状态画到「注入」页。 */
        private void RenderInject(Dictionary<string, object> st, Dictionary<string, object> targets)
        {
            if (targets != null && cmbTarget.Items.Count == 0) FillTargets(targets);
            if (initialHome.Length > 0 && cmbTarget.Text != initialHome) cmbTarget.Text = initialHome;
            Dictionary<string, object> body = st == null ? null : Bridge.Obj(st, "data");
            if (body == null) return;

            bool ext = Bridge.Flag(body, "extensionInstalled");
            Dictionary<string, object> sn = Bridge.Obj(body, "sanitized");
            bool sanitized = sn != null && Bridge.Flag(sn, "sanitized");
            if (!injectInit)
            {
                chkTakeover.Checked = Bridge.Flag(body, "override");
                injectInit = true;
            }
            if (pendingReceipt != null)
            {
                Dictionary<string, object> receipt = pendingReceipt;
                pendingReceipt = null;
                RenderInjectResult(receipt);
                return;
            }

            StringBuilder sb = new StringBuilder();
            sb.AppendLine(ext ? "✓ 已经注入到这台机器上的 Pi Agent。" : "⚠ 还没注入，点下面的「一键注入」。");            sb.AppendLine();
            if (ext) sb.AppendLine("扩展　　　" + Bridge.Str(body, "extensionFile"));
            sb.AppendLine("注入通道　" + (ext ? "扩展 · 每轮动态裁剪" : (Bridge.Flag(body, "applied") ? "AGENTS.md · 静态区块" : "无")));
            sb.AppendLine("层　　　　" + (Bridge.Str(body, "mode").Length > 0 ? Bridge.Str(body, "mode") : "按任务族裁剪"));
            sb.AppendLine("体量　　　全量 " + Bridge.Num(body, "fullChars") + " 字符");
            sb.AppendLine("完全接管　" + (Bridge.Flag(body, "override") ? "开（系统提示词整条由 ctxfold 提供）" : "关（与 Pi 内置提示词共存）"));
            sb.AppendLine("清洗　　　" + (sanitized
                ? "AGENTS.md 已清空 " + Bridge.Num(sn, "clearedChars") + " 字符，备份 " + Bridge.Count(sn, "files") + " 份"
                : "没动过原有提示词"));
            sb.AppendLine();
            sb.AppendLine(ext ? "新开一个 pi 会话就生效。" : "点「一键注入」把扩展、层、规则、技能铺进去。");
            rtbInject.Text = sb.ToString();
        }

        // ---------- 概览 ----------

        private Panel BuildOverview()
        {
            Panel page = new Panel();
            page.BackColor = Ui.Bg;
            page.Padding = new Padding(18);

            Panel bottom = new Panel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = 46;
            bottom.BackColor = Ui.Bg;
            Button refresh = Ui.Btn("刷新", true);
            refresh.Dock = DockStyle.Left;
            refresh.Click += delegate { RefreshAll(); };
            Button openHome = Ui.Btn("打开主目录", false);
            openHome.Dock = DockStyle.Left;
            openHome.Width = 110;
            openHome.Margin = new Padding(12, 0, 0, 0);
            openHome.Click += delegate { OpenPath("home"); };
            bottom.Controls.Add(openHome);
            bottom.Controls.Add(refresh);
            openHome.Left = 132;

            Label title = Ui.Lab("ctxfold", Ui.FB(20f), Ui.Text);
            title.Dock = DockStyle.Top;
            title.Height = 40;
            Label sub = Ui.Lab("Pi Agent 提示词控制台 · 注入 / 裁剪 / 清洗 / 接管", Ui.F(9f), Ui.Muted);
            sub.Dock = DockStyle.Top;
            sub.Height = 24;

            TableLayoutPanel cards = new TableLayoutPanel();
            cards.Dock = DockStyle.Top;
            cards.Height = 148;
            cards.ColumnCount = 3;
            cards.RowCount = 1;
            cards.BackColor = Ui.Bg;
            cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34f));
            cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33f));
            cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33f));

            Label b1;
            Panel c1 = Ui.CardBox("注入状态", out b1);
            b1.Font = Ui.F(10f);
            b1.ForeColor = Ui.Text;
            labChannel = b1;
            c1.Dock = DockStyle.Fill;
            c1.Margin = new Padding(0, 0, 8, 0);

            Label b2;
            Panel c2 = Ui.CardBox("提示词接管", out b2);
            b2.Font = Ui.F(10f);
            b2.ForeColor = Ui.Text;
            labOverride = b2;
            c2.Dock = DockStyle.Fill;
            c2.Margin = new Padding(4, 0, 4, 0);

            Label b3;
            Panel c3 = Ui.CardBox("AGENTS.md 清洗", out b3);
            b3.Font = Ui.F(10f);
            b3.ForeColor = Ui.Text;
            labSanitize = b3;
            c3.Dock = DockStyle.Fill;
            c3.Margin = new Padding(8, 0, 0, 0);

            cards.Controls.Add(c1, 0, 0);
            cards.Controls.Add(c2, 1, 0);
            cards.Controls.Add(c3, 2, 0);

            Panel spacer = new Panel();
            spacer.Dock = DockStyle.Top;
            spacer.Height = 10;

            Label dh = Ui.Lab("环境自检", Ui.FB(10f), Ui.Text);
            dh.Dock = DockStyle.Top;
            dh.Height = 30;

            lvDoctor = MakeList(new string[] { "项目", "结果", "详情" }, new int[] { 130, 70, 700 });
            lvDoctor.Dock = DockStyle.Fill;
            RoundedPanel doctorCard = new RoundedPanel();
            doctorCard.Dock = DockStyle.Fill;
            doctorCard.Radius = 16;
            doctorCard.Padding = new Padding(10, 6, 8, 8);
            doctorCard.Controls.Add(lvDoctor);

            page.Controls.Add(doctorCard);
            page.Controls.Add(dh);
            page.Controls.Add(spacer);
            page.Controls.Add(cards);
            page.Controls.Add(sub);
            page.Controls.Add(title);
            page.Controls.Add(bottom);
            return page;
        }

        // ---------- 提示词层 ----------

        private Panel BuildLayers()
        {
            Panel page = new Panel();
            page.BackColor = Ui.Bg;
            page.Padding = new Padding(18);

            Panel head = new Panel();
            head.Dock = DockStyle.Top;
            head.Height = 52;
            head.BackColor = Ui.Bg;
            Label tip = Ui.Lab("改完点保存：写进用户层目录，扩展每轮重读，不用重装。", Ui.F(9f), Ui.Muted);
            tip.Dock = DockStyle.Fill;
            Button openDir = Ui.Btn("层目录", false);
            openDir.Width = 90;
            openDir.Dock = DockStyle.Right;
            openDir.Click += delegate { OpenPath("layers"); };
            Button reset = Ui.Btn("回落预设", false);
            reset.Width = 100;
            reset.Dock = DockStyle.Right;
            reset.Click += delegate { ResetLayer(); };
            Button save = Ui.Btn("保存", true);
            save.Width = 90;
            save.Dock = DockStyle.Right;
            save.Click += delegate { SaveLayer(); };
            head.Controls.Add(tip);
            head.Controls.Add(openDir);
            head.Controls.Add(reset);
            head.Controls.Add(save);

            SplitContainer split = new SplitContainer();
            split.Dock = DockStyle.Fill;
            split.BackColor = Ui.Bg;
            split.SplitterDistance = 320;
            bool splitDone = false;
            split.Resize += delegate
            {
                if (splitDone) return;
                if (split.Width < 400) return;
                splitDone = true;
                try { split.SplitterDistance = Math.Max(280, (int)(split.Width * 0.36)); }
                catch (Exception) { }
            };
            split.SplitterWidth = 10;
            split.Panel1.BackColor = Ui.Bg;
            split.Panel2.BackColor = Ui.Bg;

            lvLayers = MakeList(new string[] { "层", "字符", "来源" }, new int[] { 150, 70, 70 });
            lvLayers.Dock = DockStyle.Fill;
            lvLayers.SelectedIndexChanged += delegate { LoadSelectedLayer(false); };
            RoundedPanel listCard = new RoundedPanel();
            listCard.Dock = DockStyle.Fill;
            listCard.Radius = 16;
            listCard.Padding = new Padding(10, 8, 8, 8);
            listCard.Controls.Add(lvLayers);
            split.Panel1.Controls.Add(listCard);

            txtLayer = new TextBox();
            txtLayer.Dock = DockStyle.Fill;
            txtLayer.Multiline = true;
            txtLayer.ScrollBars = ScrollBars.Vertical;
            txtLayer.WordWrap = true;
            txtLayer.AcceptsReturn = true;
            txtLayer.AcceptsTab = true;
            txtLayer.Font = Ui.M(10f);
            txtLayer.BackColor = Ui.Field;
            txtLayer.ForeColor = Ui.Text;
            txtLayer.BorderStyle = BorderStyle.None;

            RoundedPanel editWrap = new RoundedPanel();
            editWrap.Dock = DockStyle.Fill;
            editWrap.Radius = 16;
            editWrap.Shadow = false;
            editWrap.Fill = Ui.Field;
            editWrap.Padding = new Padding(12);
            editWrap.Controls.Add(txtLayer);
            split.Panel2.Controls.Add(editWrap);

            page.Controls.Add(split);
            page.Controls.Add(head);
            return page;
        }

        // ---------- 路由预览 ----------

        private Panel BuildPreview()
        {
            Panel page = new Panel();
            page.BackColor = Ui.Bg;
            page.Padding = new Padding(18);

            Label hint = Ui.Lab("输入一句任务描述，看它会被裁成哪几层。", Ui.F(9f), Ui.Muted);
            hint.Dock = DockStyle.Top;
            hint.Height = 30;

            txtRoute = new TextBox();
            txtRoute.Dock = DockStyle.Fill;
            txtRoute.Multiline = true;
            txtRoute.Font = Ui.F(10f);
            txtRoute.BackColor = Color.White;
            txtRoute.ForeColor = Ui.Text;
            txtRoute.BorderStyle = BorderStyle.None;
            txtRoute.Text = "帮我逆向这个 apk，脱壳看签名校验";

            RoundedPanel inputCard = new RoundedPanel();
            inputCard.Dock = DockStyle.Top;
            inputCard.Height = 52;
            inputCard.Radius = 16;
            inputCard.Shadow = false;
            inputCard.Padding = new Padding(14, 10, 14, 10);
            inputCard.Controls.Add(txtRoute);

            Panel row = new Panel();
            row.Dock = DockStyle.Top;
            row.Height = 56;
            row.BackColor = Ui.Bg;
            Button run = Ui.Btn("预览裁剪", true);
            run.Width = 120;
            run.Top = 10;
            run.Left = 0;
            run.Click += delegate { DoPreview(); };
            labRoute = Ui.Lab("", Ui.F(9.5f), Ui.AccentDeep);
            labRoute.Left = 134;
            labRoute.Top = 10;
            labRoute.Width = 700;
            labRoute.Height = 36;
            row.Controls.Add(labRoute);
            row.Controls.Add(run);

            rtbPreview = new RichTextBox();
            rtbPreview.Dock = DockStyle.Fill;
            rtbPreview.Font = Ui.M(9.5f);
            rtbPreview.BackColor = Color.White;
            rtbPreview.ForeColor = Ui.Text;
            rtbPreview.BorderStyle = BorderStyle.None;
            rtbPreview.ReadOnly = true;
            rtbPreview.WordWrap = true;

            RoundedPanel resultCard = new RoundedPanel();
            resultCard.Dock = DockStyle.Fill;
            resultCard.Radius = 16;
            resultCard.Padding = new Padding(12);
            resultCard.Controls.Add(rtbPreview);

            page.Controls.Add(resultCard);
            page.Controls.Add(row);
            page.Controls.Add(inputCard);
            page.Controls.Add(hint);
            return page;
        }

        // ---------- 维护 ----------

        private Panel BuildMaintenance()
        {
            Panel page = new Panel();
            page.BackColor = Ui.Bg;
            page.Padding = new Padding(18);

            FlowLayoutPanel tools = new FlowLayoutPanel();
            tools.Dock = DockStyle.Top;
            tools.Height = 56;
            tools.BackColor = Ui.Bg;
            tools.WrapContents = false;
            tools.Padding = new Padding(0, 6, 0, 6);

            Button install = Ui.Btn("安装 / 更新扩展", false);
            install.Width = 140;
            install.Click += delegate { DoInstall(); };
            Button uninstall = Ui.Btn("卸载扩展", false);
            uninstall.Width = 110;
            uninstall.Click += delegate { DoUninstall(); };
            Button openBak = Ui.Btn("备份目录", false);
            openBak.Width = 100;
            openBak.Click += delegate { OpenPath("backups"); };
            Button openExt = Ui.Btn("扩展目录", false);
            openExt.Width = 100;
            openExt.Click += delegate { OpenPath("extensions"); };
            Button refreshPatch = Ui.Btn("刷新补丁", false);
            refreshPatch.Width = 100;
            refreshPatch.Click += delegate { LoadPatches(); };
            Button ap2 = Ui.Btn("应用选中补丁", true);
            ap2.Width = 118;
            ap2.Click += delegate { DoPatch("apply"); };
            Button rv = Ui.Btn("撤销选中补丁", false);
            rv.Width = 118;
            rv.Click += delegate { DoPatch("revert"); };
            tools.Controls.Add(install);
            tools.Controls.Add(uninstall);
            tools.Controls.Add(openBak);
            tools.Controls.Add(openExt);
            tools.Controls.Add(refreshPatch);
            tools.Controls.Add(ap2);
            tools.Controls.Add(rv);

            RoundedPanel optsCard = new RoundedPanel();
            optsCard.Dock = DockStyle.Top;
            optsCard.Height = 56;
            optsCard.Radius = 16;
            optsCard.Shadow = false;
            optsCard.Padding = new Padding(16, 12, 16, 12);

            chkEnabled = new SoftCheck();
            chkEnabled.Text = "启用扩展注入";
            chkEnabled.AutoSize = false;
            chkEnabled.Left = 0;
            chkEnabled.Top = 4;
            chkEnabled.Width = 178;
            chkEnabled.Height = 26;
            chkEnabled.CheckedChanged += delegate { SaveOptions(); };
            chkRouting = new SoftCheck();
            chkRouting.Text = "按任务族裁剪";
            chkRouting.AutoSize = false;
            chkRouting.Left = 190;
            chkRouting.Top = 4;
            chkRouting.Width = 170;
            chkRouting.Height = 26;
            chkRouting.CheckedChanged += delegate { SaveOptions(); };
            Label ap = Ui.Lab("审批", Ui.F(9f), Ui.Muted);
            ap.Left = 376;
            ap.Top = 8;
            ap.Width = 40;
            cmbApproval = new ComboBox();
            cmbApproval.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbApproval.Left = 418;
            cmbApproval.Top = 5;
            cmbApproval.Width = 110;
            cmbApproval.FlatStyle = FlatStyle.Flat;
            cmbApproval.BackColor = Color.White;
            cmbApproval.ForeColor = Ui.Text;
            cmbApproval.Items.AddRange(new object[] { "auto", "confirm", "deny" });
            cmbApproval.SelectedIndexChanged += delegate
            {
                if (cmbApproval.Focused) SaveOptions();
            };
            optsCard.Controls.Add(chkEnabled);
            optsCard.Controls.Add(chkRouting);
            optsCard.Controls.Add(ap);
            optsCard.Controls.Add(cmbApproval);
            Panel opts = new Panel();
            opts.Dock = DockStyle.Top;
            opts.Height = 68;
            opts.BackColor = Ui.Bg;
            opts.Controls.Add(optsCard);

            Label ph = Ui.Lab("本机 Pi 上游补丁（可选，升级 Pi 后需要重打）", Ui.FB(10f), Ui.Text);
            ph.Dock = DockStyle.Top;
            ph.Height = 30;

            lvPatches = MakeList(new string[] { "补丁", "状态", "作用" }, new int[] { 300, 78, 560 });
            lvPatches.Dock = DockStyle.Fill;
            RoundedPanel patchCard = new RoundedPanel();
            patchCard.Dock = DockStyle.Fill;
            patchCard.Radius = 16;
            patchCard.Padding = new Padding(10, 6, 8, 8);
            patchCard.Controls.Add(lvPatches);



            page.Controls.Add(patchCard);
            page.Controls.Add(ph);
            page.Controls.Add(opts);
            page.Controls.Add(tools);
            return page;
        }

        private static string Clip(string s, int max)
        {
            if (s == null) return "";
            if (s.Length <= max) return s;
            return s.Substring(0, max) + "…";
        }

        private ListView MakeList(string[] heads, int[] widths)
        {            ListView lv = new ListView();
            lv.View = View.Details;
            lv.FullRowSelect = true;
            lv.HideSelection = false;
            lv.MultiSelect = false;
            lv.BorderStyle = BorderStyle.None;
            lv.BackColor = Ui.Card;
            lv.ForeColor = Ui.Text;
            lv.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            lv.Font = Ui.F(9.5f);
            lv.SmallImageList = new ImageList();
            lv.SmallImageList.ImageSize = new Size(1, 34);
            for (int i = 0; i < heads.Length; i++)
            {
                lv.Columns.Add(heads[i], widths[i]);
            }
            return lv;
        }

        // ---------- 后端调用 ----------

        private void SetBusy(bool on, string text)
        {
            bar.Visible = on;
            labStatus.Text = text == null ? "就绪" : text;
            Cursor = on ? Cursors.WaitCursor : Cursors.Default;
        }

        private void Run(string busy, Func<Dictionary<string, object>> work, Action<Dictionary<string, object>> done)
        {
            SetBusy(true, busy);
            Task.Factory.StartNew<Dictionary<string, object>>(work).ContinueWith(
                delegate(Task<Dictionary<string, object>> t)
                {
                    if (IsDisposed) return;
                    try
                    {
                        BeginInvoke((Action)delegate
                        {
                            SetBusy(false, null);
                            Dictionary<string, object> r = t.Result;
                            if (!Bridge.Ok(r))
                            {
                                string msg = Bridge.Str(r, "error");
                                if (msg.Length == 0) msg = "后端调用失败";
                                MessageBox.Show(this, msg, "ctxfold", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                                labStatus.Text = "失败：" + msg.Replace("\r", " ").Replace("\n", " ");
                                return;
                            }
                            done(r);
                        });
                    }
                    catch (Exception ex)
                    {
                        try
                        {
                            BeginInvoke((Action)delegate
                            {
                                SetBusy(false, null);
                                MessageBox.Show(this, ex.Message, "ctxfold", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                            });
                        }
                        catch { }
                    }
                });
        }

        private static Dictionary<string, object> Arg(params object[] pairs)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2)
            {
                d[Convert.ToString(pairs[i])] = pairs[i + 1];
            }
            return d;
        }

        // ---------- 数据加载 ----------

        /** 当前选中的目标目录；空则让后端用默认目录。 */
        private Dictionary<string, object> HomeArgs()
        {
            Dictionary<string, object> args = new Dictionary<string, object>();
            string h = (cmbTarget.Text ?? "").Trim();
            if (h.Length > 0) args["home"] = h;
            return args;
        }

        private void RefreshAll()
        {
            Run("读取状态…", delegate
            {
                Dictionary<string, object> pick = HomeArgs();
                Dictionary<string, object> status = Bridge.Call("status", pick);
                Dictionary<string, object> doctor = Bridge.Call("doctor", pick);
                Dictionary<string, object> layers = Bridge.Call("layers", pick);
                Dictionary<string, object> targets = Bridge.Call("targets", null);
                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["status"] = status;
                result["doctor"] = doctor;
                result["layers"] = layers;
                result["targets"] = targets;
                return result;
            }, delegate(Dictionary<string, object> r)
            {
                Dictionary<string, object> st = r.ContainsKey("status") ? r["status"] as Dictionary<string, object> : null;
                Dictionary<string, object> dr = r.ContainsKey("doctor") ? r["doctor"] as Dictionary<string, object> : null;
                Dictionary<string, object> ly = r.ContainsKey("layers") ? r["layers"] as Dictionary<string, object> : null;
                Dictionary<string, object> tg = r.ContainsKey("targets") ? r["targets"] as Dictionary<string, object> : null;
                RenderInject(st, tg);
                RenderOverview(st, dr);
                RenderLayers(ly);
                LoadPatches();
            });
        }

        private void RenderOverview(Dictionary<string, object> st, Dictionary<string, object> dr)
        {
            if (st != null)
            {
                Dictionary<string, object> body = Bridge.Obj(st, "data");
                if (body != null)
                {
                    bool ext = Bridge.Flag(body, "extensionInstalled");
                    bool applied = Bridge.Flag(body, "applied");
                    string channel = ext ? "扩展 · 每轮动态" : (applied ? "AGENTS.md · 静态区块" : "未注入");
                    int chars = Bridge.Num(body, "chars");
                    int tokens = Bridge.Num(body, "tokens");
                    int uchars = Bridge.Num(body, "userContentChars");
                    int fullChars = Bridge.Num(body, "fullChars");
                    string mode = Bridge.Str(body, "mode");
                    string sizeText = ext
                        ? "动态 · 全量 " + fullChars + " 字符"
                        : chars + "（估算 " + tokens + " tokens）";
                    labChannel.Text = "通道　" + channel
                        + "\r\n层　　 " + (mode.Length > 0 ? mode : "按任务族裁剪")
                        + "\r\n字符　 " + sizeText
                        + "\r\n自有　 " + uchars + " 字符（AGENTS.md 区块外）";

                    bool ov = Bridge.Flag(body, "override");
                    bool routing = Bridge.Flag(body, "routing");
                    labOverride.Text = (ov
                        ? "★ 完全接管\r\n系统提示词整条由 ctxfold 提供\r\nPi 内置提示词与原 AGENTS.md 都不参与"
                        : "追加模式\r\nPi 内置提示词 + 原 AGENTS.md 仍然生效\r\nctxfold 只在末尾追加一段")
                        + "\r\n裁剪　" + (routing ? "开（按任务族）" : "关（永远全量）");

                    Dictionary<string, object> sn = Bridge.Obj(body, "sanitized");
                    if (sn != null && Bridge.Flag(sn, "sanitized"))
                    {
                        labSanitize.Text = "已清洗\r\n" + Bridge.Str(sn, "at")
                            + "\r\n清空 " + Bridge.Num(sn, "clearedChars") + " 字符"
                            + "\r\n备份 " + Bridge.Num(sn, "files") + " 份";
                    }
                    else if (uchars == 0)
                    {
                        labSanitize.Text = "AGENTS.md 为空\r\n没有需要清洗的内容";
                    }
                    else
                    {
                        labSanitize.Text = "未清洗\r\nAGENTS.md 里还有 " + uchars + " 字符\r\n点「清洗并接管」把它们移出提示词";
                    }
                }
            }

            if (st != null)
            {
                Dictionary<string, object> body2 = Bridge.Obj(st, "data");
                if (body2 != null)
                {
                    loadingOptions = true;
                    try
                    {
                        chkEnabled.Checked = Bridge.Flag(body2, "enabled");
                        chkRouting.Checked = Bridge.Flag(body2, "routing");
                        string ap = Bridge.Str(body2, "approval");
                        if (ap.Length == 0) ap = "auto";
                        cmbApproval.SelectedItem = ap;
                    }
                    finally
                    {
                        loadingOptions = false;
                    }
                }
            }

            if (dr != null)
            {
                Dictionary<string, object> body = Bridge.Obj(dr, "data");
                lvDoctor.BeginUpdate();
                lvDoctor.Items.Clear();
                foreach (object o in Bridge.Items(body, "checks"))
                {
                    Dictionary<string, object> c = o as Dictionary<string, object>;
                    if (c == null) continue;
                    ListViewItem it = new ListViewItem(Bridge.Str(c, "id"));
                    it.SubItems.Add(Bridge.Flag(c, "ok") ? "通过" : "问题");
                    it.SubItems.Add(Bridge.Str(c, "detail"));
                    it.ForeColor = Bridge.Flag(c, "ok") ? Ui.Text : Ui.Warn;
                    lvDoctor.Items.Add(it);
                }
                lvDoctor.EndUpdate();
            }
        }

        private void RenderLayers(Dictionary<string, object> ly)
        {
            Dictionary<string, object> body = ly == null ? null : Bridge.Obj(ly, "data");
            lvLayers.BeginUpdate();
            lvLayers.Items.Clear();
            foreach (object o in Bridge.Items(body, "layers"))
            {
                Dictionary<string, object> l = o as Dictionary<string, object>;
                if (l == null) continue;
                ListViewItem it = new ListViewItem(Bridge.Str(l, "name"));
                it.SubItems.Add(Bridge.Str(l, "chars"));
                it.SubItems.Add(Bridge.Str(l, "source"));
                it.Tag = Bridge.Str(l, "name");
                lvLayers.Items.Add(it);
            }
            lvLayers.EndUpdate();
            if (lvLayers.Items.Count > 0 && lvLayers.SelectedIndices.Count == 0)
            {
                lvLayers.Items[0].Selected = true;
            }
        }

        private void LoadSelectedLayer(bool force)
        {
            if (lvLayers.SelectedItems.Count == 0) return;
            string name = Convert.ToString(lvLayers.SelectedItems[0].Tag);
            if (name == null || name.Length == 0) return;
            if (!force && name == currentLayer && txtLayer.Text.Length > 0) return;
            currentLayer = name;
            Run("读取层 " + name + "…",
                delegate { return Bridge.Call("layer-read", Arg("name", name)); },
                delegate(Dictionary<string, object> r)
                {
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    txtLayer.Text = body == null ? "" : Bridge.Str(body, "text");
                    txtLayer.SelectionStart = 0;
                    txtLayer.SelectionLength = 0;
                    labStatus.Text = "层 " + name + " · " + Bridge.Str(body, "source") + " · " + txtLayer.Text.Length + " 字符";
                });
        }

        private void SaveLayer()
        {
            if (currentLayer.Length == 0)
            {
                MessageBox.Show(this, "先在左边选一层。", "ctxfold", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string text = txtLayer.Text;
            string name = currentLayer;
            Run("保存层 " + name + "…",
                delegate { return Bridge.Call("layer-write", Arg("name", name, "text", text)); },
                delegate(Dictionary<string, object> r)
                {
                    labStatus.Text = "已保存 " + name + " · " + text.Length + " 字符";
                    RefreshAll();
                });
        }

        private void ResetLayer()
        {
            if (currentLayer.Length == 0) return;
            if (MessageBox.Show(this, "删掉用户覆盖层，回落到预设版本？", "ctxfold",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            string name = currentLayer;
            Run("回落到预设…",
                delegate { return Bridge.Call("layer-reset", Arg("name", name)); },
                delegate
                {
                    currentLayer = "";
                    RefreshAll();
                });
        }

        private void DoPreview()
        {
            string text = txtRoute.Text;
            Run("计算裁剪…",
                delegate { return Bridge.Call("preview", Arg("text", text)); },
                delegate(Dictionary<string, object> r)
                {
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    string fam = Bridge.Str(body, "family");
                    string label = Bridge.Str(body, "familyLabel");
                    List<string> names = new List<string>();
                    foreach (object o in Bridge.Items(body, "layers")) names.Add(Convert.ToString(o));
                    int chars = Bridge.Num(body, "chars");
                    int tokens = Bridge.Num(body, "tokens");
                    labRoute.Text = "族 " + label + "（" + fam + "）· 层 " + string.Join(" + ", names.ToArray())
                        + " · " + chars + " 字符 / 约 " + tokens + " tokens";
                    rtbPreview.Text = Bridge.Str(body, "text");
                    rtbPreview.SelectionStart = 0;
                });
        }

        private void LoadPatches()
        {
            Run("读取补丁状态…",
                delegate { return Bridge.Call("patches", null); },
                delegate(Dictionary<string, object> r)
                {
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    lvPatches.BeginUpdate();
                    lvPatches.Items.Clear();
                    bool ok = body != null && Bridge.Flag(body, "ok");
                    foreach (object o in Bridge.Items(body, "patches"))
                    {
                        Dictionary<string, object> p = o as Dictionary<string, object>;
                        if (p == null) continue;
                        ListViewItem it = new ListViewItem(Bridge.Str(p, "id"));
                        bool ap = Bridge.Flag(p, "applied");
                        bool pend = Bridge.Flag(p, "pending");
                        it.SubItems.Add(ap ? "已打" : (pend ? "可打" : "不适用"));
                        it.SubItems.Add(Clip(Bridge.Str(p, "effect"), 68));
                        it.Tag = Bridge.Str(p, "id");
                        it.ForeColor = ap ? Ui.Accent : (pend ? Ui.Text : Ui.Muted);
                        lvPatches.Items.Add(it);
                    }
                    lvPatches.EndUpdate();
                    if (body != null && !ok)
                    {
                        labStatus.Text = "补丁：" + Bridge.Str(body, "reason");
                    }
                });
        }

        private void DoPatch(string action)
        {
            if (lvPatches.SelectedItems.Count == 0)
            {
                MessageBox.Show(this, "先在列表里选一条补丁。", "ctxfold", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string id = Convert.ToString(lvPatches.SelectedItems[0].Tag);
            if (MessageBox.Show(this, (action == "apply" ? "打上补丁 " : "撤销补丁 ") + id + "？\n会改写本机 Pi 发布包内的文件。",
                "ctxfold", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            Run(action == "apply" ? "打补丁…" : "撤补丁…",
                delegate { return Bridge.Call("patch", Arg("id", id, "action", action)); },
                delegate { LoadPatches(); });
        }

        private void DoClean()
        {
            if (MessageBox.Show(this,
                "清洗 = 把 AGENTS.md 里的内容移出提示词，并打开「完全接管」。\n\n· 原文会完整备份\n· 之前那份提示词不再进入系统提示词\n· 随时可以「还原提示词」撤回\n\n继续？",
                "清洗并接管", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            Run("清洗中…",
                delegate { return Bridge.Call("clean", Arg("project", false)); },
                delegate(Dictionary<string, object> r)
                {
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    MessageBox.Show(this, Summarize(body, "清洗完成"), "ctxfold",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    RefreshAll();
                });
        }

        private void DoRestore()
        {
            if (MessageBox.Show(this, "按清洗记录把原提示词写回 AGENTS.md？", "还原提示词",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            Run("还原中…",
                delegate { return Bridge.Call("restore", null); },
                delegate(Dictionary<string, object> r)
                {
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    MessageBox.Show(this, Summarize(body, "还原完成"), "ctxfold",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    RefreshAll();
                });
        }

        private static string Summarize(Dictionary<string, object> body, string head)
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine(head);
            if (body == null) return sb.ToString();
            foreach (object o in Bridge.Items(body, "files"))
            {
                Dictionary<string, object> f = o as Dictionary<string, object>;
                if (f == null) continue;
                string file = Bridge.Str(f, "file");
                if (file.Length == 0) file = Bridge.Str(f, "missing");
                sb.AppendLine("· " + file);
                if (Bridge.Num(f, "before") > 0)
                {
                    sb.AppendLine("  " + Bridge.Num(f, "before") + " → " + Bridge.Num(f, "after") + " 字符");
                }
                string bak = Bridge.Str(f, "backup");
                if (bak.Length > 0) sb.AppendLine("  备份 " + bak);
            }
            return sb.ToString().TrimEnd();
        }

        private void DoInstall()
        {
            Run("安装扩展…",
                delegate { return Bridge.Call("install", Arg("force", true)); },
                delegate(Dictionary<string, object> r)
                {
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    int n = 0;
                    foreach (object o in Bridge.Items(body, "copied")) n++;
                    labStatus.Text = "扩展已更新 · " + n + " 个文件";
                    MessageBox.Show(this, "扩展已安装到：\n" + Bridge.Str(body, "home")
                        + "\n\n文件 " + n + " 个。已开着的 Pi 会话需要重开才会加载新代码。",
                        "ctxfold", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    RefreshAll();
                });
        }

        private void DoUninstall()
        {
            if (MessageBox.Show(this, "移除扩展与技能包？\n用户层与备份会保留。", "卸载",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            Run("卸载…",
                delegate { return Bridge.Call("uninstall", null); },
                delegate(Dictionary<string, object> r)
                {
                    RefreshAll();
                    MessageBox.Show(this, "已移除扩展与技能包。", "ctxfold",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                });
        }

        private void SaveOptions()
        {
            if (loadingOptions) return;
            Dictionary<string, object> patch = new Dictionary<string, object>();
            patch["enabled"] = chkEnabled.Checked;
            patch["routing"] = chkRouting.Checked;
            patch["approval"] = Convert.ToString(cmbApproval.SelectedItem);
            Run("保存设置…",
                delegate { return Bridge.Call("options", Arg("patch", patch)); },
                delegate { labStatus.Text = "设置已保存"; });
        }

        /** 用 WScript.Shell 生成桌面快捷方式（无需 COM 引用，走 IDispatch 晚期绑定）。 */
        private void MakeShortcut()
        {
            if (Shortcut.Create())
            {
                labStatus.Text = "桌面快捷方式已创建：" + Shortcut.LinkPath();
                return;
            }
            labStatus.Text = "快捷方式创建失败";
            MessageBox.Show(this, "写桌面快捷方式时出错（可能被安全软件拦了）", "创建快捷方式失败",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        private void OpenPath(string which)
        {            Run("定位目录…",
                delegate
                {
                    Dictionary<string, object> r = Bridge.Call("paths", null);
                    Dictionary<string, object> body = Bridge.Obj(r, "data");
                    string dir = body == null ? "" : Bridge.Str(body, which);
                    if (dir.Length > 0 && Directory.Exists(dir))
                    {
                        Process.Start("explorer.exe", "\"" + dir + "\"");
                    }
                    else
                    {
                        MessageBox.Show(this, "目录还不存在：\n" + dir, "ctxfold",
                            MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    return r;
                },
                delegate { });
        }
    }

    internal sealed class FlatMenu : ToolStripProfessionalRenderer
    {
        public FlatMenu()
            : base(new FlatColors())
        {
            RoundedEdges = false;
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected)
            {
                base.OnRenderMenuItemBackground(e);
                return;
            }
            using (SolidBrush b = new SolidBrush(Color.FromArgb(0x2A, 0x30, 0x3A)))
            {
                e.Graphics.FillRectangle(b, new Rectangle(Point.Empty, e.Item.Size));
            }
        }
    }

    internal sealed class FlatColors : ProfessionalColorTable
    {
        public override Color MenuItemSelected { get { return Color.FromArgb(0x2A, 0x30, 0x3A); } }
        public override Color MenuItemBorder { get { return Ui.Accent; } }
        public override Color ToolStripDropDownBackground { get { return Ui.Card; } }
        public override Color ImageMarginGradientBegin { get { return Ui.Card; } }
        public override Color ImageMarginGradientMiddle { get { return Ui.Card; } }
        public override Color ImageMarginGradientEnd { get { return Ui.Card; } }
        public override Color MenuBorder { get { return Ui.Border; } }
    }

    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main()
        {
            try { SetProcessDPIAware(); }
            catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string[] argv = Environment.GetCommandLineArgs();
            bool wantShortcut = argv.Length > 1 && string.Equals(argv[1], "--shortcut", StringComparison.OrdinalIgnoreCase);
            if (wantShortcut)
            {
                Environment.Exit(Shortcut.Create() ? 0 : 1);
            }
            Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e)
            {
                MessageBox.Show(e.Exception.Message, "ctxfold", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            bool first;
            string initial = "";
            for (int i = 1; i < argv.Length - 1; i++)
            {
                if (string.Equals(argv[i], "--home", StringComparison.OrdinalIgnoreCase)) initial = argv[i + 1];
            }
            using (System.Threading.Mutex single = new System.Threading.Mutex(true, "ctxfold-app-single", out first))
            {
                if (!first) return;
                Application.Run(new MainForm(initial));
            }
        }
    }
}