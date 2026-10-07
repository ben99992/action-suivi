' Runs sync.mjs without opening a window (scheduled task "Action suivi", every 2 minutes).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run """C:\Program Files\nodejs\node.exe"" sync.mjs", 0, True
