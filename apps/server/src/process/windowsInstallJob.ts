// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone Node launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const windowsJobApi = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class T3InstallJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] Processes(string name, int pid, bool create) {
    IntPtr job = create ? CreateJobObject(IntPtr.Zero, name) : OpenJobObject(4, false, name);
    if (job == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (!create && error == 2) return new int[0];
      throw new Win32Exception(error);
    }
    try {
      if (create) {
        IntPtr process = OpenProcess(0x101, false, pid);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
          if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { CloseHandle(process); }
      }
      IntPtr info = Marshal.AllocHGlobal(65536);
      try {
        if (!QueryInformationJobObject(job, 3, info, 65536, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int count = Marshal.ReadInt32(info, 4);
        int[] pids = new int[count];
        for (int i = 0; i < count; i++) pids[i] = Marshal.ReadIntPtr(info, 8 + i * IntPtr.Size).ToInt32();
        return pids;
      } finally { Marshal.FreeHGlobal(info); }
    } finally { CloseHandle(job); }
  }
}`;

function argsFor(pid: number, job: string, create: boolean) {
  if (!/^t3-provider-install-[a-f0-9-]+$/.test(job) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid provider install job");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${windowsJobApi}\n'@; [T3InstallJob]::Processes('Global\\${job}', ${pid}, $${create})`,
  ];
}
function decode(stdout: string, queryPid?: number): ReadonlyArray<number> {
  const children = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(Number);
  if (children.some((child) => !Number.isSafeInteger(child) || child <= 0))
    throw new Error("Could not inspect provider installer processes");
  return children.filter((child) => child !== queryPid);
}
/** The kernel retains install helpers even after their parents exit. */
export function processes(pid: number, job: string, create = false) {
  const scan = NodeChildProcess.spawnSync("powershell.exe", argsFor(pid, job, create), {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (scan.error || scan.status !== 0)
    throw new Error("Could not inspect provider installer processes");
  return decode(scan.stdout, scan.pid);
}
/** Startup cleanup must keep the server responsive while PowerShell inspects the job. */
export async function processesAsync(pid: number, job: string, environment: NodeJS.ProcessEnv) {
  const args = argsFor(pid, job, false);
  try {
    const query = execFile("powershell.exe", args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: environment,
    });
    const { stdout } = await query;
    return decode(stdout, query.child.pid);
  } catch {
    throw new Error("Could not inspect provider installer processes");
  }
}
