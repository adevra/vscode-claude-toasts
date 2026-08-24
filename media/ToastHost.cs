// Toast host for vscode-claude-toasts reply boxes.
//
// Windows only delivers a toast's typed text (UserInput) to the PROCESS THAT
// CREATED the toast, via the in-process Activated event - protocol activation
// cannot carry it. PowerShell cannot subscribe to WinRT events at all, so this
// small .NET Framework exe exists: the extension spawns it lazily when a
// reply-capable toast fires, talks a line protocol over stdio, and lets it exit
// after a few idle minutes. Steady-state cost: zero.
//
// stdin:  show|<id>|<tag>|<group>|<xmlBase64>
//         hide|<tag>|<group>
//         exit
// stdout: ready
//         shown|<id>
//         activated|<id>|<argsBase64>|<replyBase64>   (reply empty when no input)
//         dismissed|<id>|<reason>
//         err|<msgBase64>
//
// Compiled on the user's machine with the csc.exe that ships with Windows:
// no binaries in the repo or the VSIX.

using System;
using System.Collections.Generic;
using System.Text;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

internal static class Program
{
    private static readonly object Gate = new object();
    private static string _appId = "ClaudeCode.VSCodeToasts";

    private static void Emit(string line)
    {
        lock (Gate)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static string B64(string s)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(s ?? ""));
    }

    private static string UnB64(string s)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(s));
    }

    private static void Main(string[] args)
    {
        if (args.Length > 0 && !string.IsNullOrEmpty(args[0]))
        {
            _appId = args[0];
        }
        var notifier = ToastNotificationManager.CreateToastNotifier(_appId);
        Emit("ready");

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            try
            {
                var parts = line.Split(new[] { '|' }, 5);
                switch (parts[0])
                {
                    case "show":
                        Show(notifier, parts[1], parts[2], parts[3], UnB64(parts[4]));
                        break;
                    case "hide":
                        try { ToastNotificationManager.History.Remove(parts[1], parts[2], _appId); } catch { }
                        break;
                    case "exit":
                        return;
                }
            }
            catch (Exception ex)
            {
                Emit("err|" + B64(ex.Message));
            }
        }
    }

    private static void Show(ToastNotifier notifier, string id, string tag, string group, string xml)
    {
        var doc = new XmlDocument();
        doc.LoadXml(xml);
        var toast = new ToastNotification(doc) { Tag = tag, Group = group };

        toast.Activated += (sender, e) =>
        {
            var activated = e as ToastActivatedEventArgs;
            var arguments = activated != null ? activated.Arguments : "";
            var reply = "";
            try
            {
                if (activated != null && activated.UserInput != null)
                {
                    object value;
                    if (activated.UserInput.TryGetValue("reply", out value) && value != null)
                    {
                        reply = value.ToString();
                    }
                }
            }
            catch { }
            Emit("activated|" + id + "|" + B64(arguments) + "|" + B64(reply));
        };
        toast.Dismissed += (sender, e) =>
        {
            Emit("dismissed|" + id + "|" + e.Reason);
        };
        toast.Failed += (sender, e) =>
        {
            Emit("err|" + B64("toast failed: " + e.ErrorCode));
        };

        notifier.Show(toast);
        Emit("shown|" + id);
    }
}
